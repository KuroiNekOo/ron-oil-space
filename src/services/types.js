// Référentiel unifié des Type (cf. modèle Prisma `Type`) — utilisé par notes de
// frais (Expense.type) et achats (Purchase.typeKey). Chaque Type a une `key`
// stable (slug) et un `label` modifiable. Sa présence dans `ExpenseTypeConfig`
// / `PurchaseTypeConfig` contrôle la disponibilité dans chaque domaine.
//
// Catégories : pilotent le bucketing sur /admin/statistiques. Valeurs autorisées
// dans `CATEGORIES`. null = type sans catégorie = bucket "Autres".
const prisma = require('../db');

const CATEGORIES = ['VEHICULE', 'MATIERE_PREMIERE', 'JURIDIQUE'];

const CATEGORY_LABELS = {
  VEHICULE: 'Véhicules',
  MATIERE_PREMIERE: 'Matières premières',
  JURIDIQUE: 'Contractuelles',
};

// Seed bootstrap au démarrage : recrée les 6 types de notes de frais historiques
// si la table Type est vide. Sert à amorcer un environnement neuf ; en environne-
// ment existant le script `scripts/migrate-unified-types.js` aura déjà tout copié
// depuis ExpenseType + PurchaseType.
const DEFAULT_EXPENSE_TYPES = [
  { key: 'carburant',  label: 'Carburant',   reimbursementPercent: 100 },
  { key: 'repas',      label: 'Repas',       reimbursementPercent: 50  },
  { key: 'transport',  label: 'Transport',   reimbursementPercent: 50  },
  { key: 'equipement', label: 'Équipement',  reimbursementPercent: 50  },
  { key: 'peage',      label: 'Péage',       reimbursementPercent: 50  },
  { key: 'autre',      label: 'Autre',       reimbursementPercent: 50  },
];

let seedPromise = null;
function ensureSeeded() {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    const count = await prisma.type.count();
    if (count > 0) return;
    const legacy = await prisma.config.findUnique({ where: { key: 'autreRemboursementPercent' } });
    const autreOverride = legacy ? parseFloat(legacy.value) : NaN;
    for (const d of DEFAULT_EXPENSE_TYPES) {
      const pct = (d.key === 'autre' && isFinite(autreOverride)) ? autreOverride : d.reimbursementPercent;
      await prisma.type.upsert({
        where: { key: d.key },
        create: {
          key: d.key, label: d.label,
          expenseConfig: { create: { reimbursementPercent: pct } },
        },
        update: {},
      });
    }
  })().catch(err => { seedPromise = null; throw err; });
  return seedPromise;
}

function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sanitizePct(v) {
  const n = parseFloat(v);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function sanitizeCategory(v) {
  if (v == null || v === '') return null;
  const s = String(v).toUpperCase();
  return CATEGORIES.includes(s) ? s : null;
}

// ── Lecture ──

// Renvoie tous les Type avec leurs configs ; inclut les archivés sauf si
// `excludeArchived` est passé. Trié par position puis label.
async function getTypes({ excludeArchived = false } = {}) {
  await ensureSeeded();
  const where = excludeArchived ? { archived: false } : {};
  return prisma.type.findMany({
    where,
    include: { expenseConfig: true, purchaseConfig: true },
    orderBy: [{ position: 'asc' }, { label: 'asc' }],
  });
}

// Types utilisables côté notes de frais (présence d'ExpenseTypeConfig, non
// archivés). Forme retournée alignée sur l'ancien API `getExpenseTypes()` :
//   [{ id, key, label, reimbursementPercent }, ...]
async function getExpenseTypes() {
  await ensureSeeded();
  const rows = await prisma.type.findMany({
    where: { archived: false, expenseConfig: { isNot: null } },
    include: { expenseConfig: true },
    orderBy: [{ position: 'asc' }, { label: 'asc' }],
  });
  return rows.map(t => ({
    id: t.id,
    key: t.key,
    label: t.label,
    reimbursementPercent: t.expenseConfig ? t.expenseConfig.reimbursementPercent : 0,
  }));
}

// Types utilisables côté achats. Forme :
//   [{ id, key, label, category }, ...]
async function getPurchaseTypes() {
  await ensureSeeded();
  const rows = await prisma.type.findMany({
    where: { archived: false, purchaseConfig: { isNot: null } },
    include: { purchaseConfig: true },
    orderBy: [{ position: 'asc' }, { label: 'asc' }],
  });
  return rows.map(t => ({
    id: t.id,
    key: t.key,
    label: t.label,
    category: t.category,
  }));
}

// ── Écriture ──

// Création d'un Type. `scope` = { expense: bool, purchase: bool, reimbursementPercent }
// crée les configs correspondantes en transaction.
async function createType({ label, category, scope }) {
  const lbl = String(label || '').trim();
  if (!lbl) throw new Error('Libellé requis');
  const key = slugify(lbl);
  if (!key) throw new Error('Slug invalide');
  const cat = sanitizeCategory(category);

  const expense = scope && scope.expense ? { create: { reimbursementPercent: sanitizePct(scope.reimbursementPercent) } } : undefined;
  const purchase = scope && scope.purchase ? { create: {} } : undefined;

  return prisma.type.create({
    data: {
      key, label: lbl, category: cat,
      expenseConfig: expense,
      purchaseConfig: purchase,
    },
    include: { expenseConfig: true, purchaseConfig: true },
  });
}

// Mise à jour partielle. `scope` accepte expense/purchase booléens : create/delete
// la config si nécessaire. Le `key` est immuable (jamais modifié).
async function updateType(id, body = {}) {
  const data = {};
  if (body.label !== undefined) {
    const lbl = String(body.label).trim();
    if (!lbl) throw new Error('Libellé requis');
    data.label = lbl;
  }
  if (body.category !== undefined) {
    data.category = sanitizeCategory(body.category);
  }
  if (body.position !== undefined) {
    const n = parseInt(body.position);
    if (isFinite(n)) data.position = n;
  }
  if (body.archived !== undefined) {
    data.archived = !!body.archived;
  }

  return prisma.$transaction(async (tx) => {
    if (Object.keys(data).length > 0) {
      await tx.type.update({ where: { id }, data });
    }

    if (body.scope) {
      const s = body.scope;
      if (s.expense !== undefined) {
        if (s.expense) {
          const pct = sanitizePct(s.reimbursementPercent);
          await tx.expenseTypeConfig.upsert({
            where: { typeId: id },
            create: { typeId: id, reimbursementPercent: pct },
            update: { reimbursementPercent: pct },
          });
        } else {
          // Ne pas faire échouer si pas de config — delete idempotent via deleteMany
          await tx.expenseTypeConfig.deleteMany({ where: { typeId: id } });
        }
      } else if (s.reimbursementPercent !== undefined) {
        // Mise à jour du % sans toucher au scope (cas où expense est déjà activé)
        await tx.expenseTypeConfig.updateMany({
          where: { typeId: id },
          data: { reimbursementPercent: sanitizePct(s.reimbursementPercent) },
        });
      }
      if (s.purchase !== undefined) {
        if (s.purchase) {
          await tx.purchaseTypeConfig.upsert({
            where: { typeId: id },
            create: { typeId: id },
            update: {},
          });
        } else {
          await tx.purchaseTypeConfig.deleteMany({ where: { typeId: id } });
        }
      }
    }

    return tx.type.findUnique({
      where: { id },
      include: { expenseConfig: true, purchaseConfig: true },
    });
  });
}

// Hard-delete d'un Type. Échoue si des Expense ou Purchase y réfèrent encore.
// Préférer `updateType(id, { archived: true })` pour conserver l'historique.
async function deleteType(id) {
  const type = await prisma.type.findUnique({ where: { id } });
  if (!type) throw new Error('Type introuvable');
  const [expenseCount, purchaseCount] = await Promise.all([
    prisma.expense.count({ where: { type: type.key } }),
    prisma.purchase.count({ where: { typeKey: type.key } }),
  ]);
  if (expenseCount + purchaseCount > 0) {
    throw new Error(`Impossible de supprimer : ${expenseCount} note(s) de frais et ${purchaseCount} achat(s) référencent ce type. Archivez-le à la place.`);
  }
  return prisma.type.delete({ where: { id } });
}

// Calcule le refund effectif d'une note de frais. `expenseTypes` est le snapshot
// renvoyé par getExpenseTypes() — à passer pour éviter une requête par expense.
function computeRefund(typeKey, amount, expenseTypes) {
  const t = String(typeKey || '').toLowerCase();
  const arr = expenseTypes || [];
  const hit = arr.find(x => x.key.toLowerCase() === t);
  if (hit) return (parseFloat(amount) || 0) * (hit.reimbursementPercent / 100);
  const fallback = arr.find(x => x.key.toLowerCase() === 'autre');
  return (parseFloat(amount) || 0) * ((fallback ? fallback.reimbursementPercent : 0) / 100);
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABELS,
  ensureSeeded,
  slugify,
  getTypes,
  getExpenseTypes,
  getPurchaseTypes,
  createType,
  updateType,
  deleteType,
  computeRefund,
};
