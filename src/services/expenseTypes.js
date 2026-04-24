// Types de notes de frais éditables. Seedés à la première lecture avec les 6
// valeurs historiques. Si l'ancienne clé Config `autreRemboursementPercent`
// existe, sa valeur est reprise pour le type "autre".
const prisma = require('../db');

const DEFAULTS = [
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
    const count = await prisma.expenseType.count();
    if (count > 0) return;
    const legacy = await prisma.config.findUnique({ where: { key: 'autreRemboursementPercent' } });
    const autreOverride = legacy ? parseFloat(legacy.value) : NaN;
    for (const d of DEFAULTS) {
      const pct = (d.key === 'autre' && isFinite(autreOverride)) ? autreOverride : d.reimbursementPercent;
      // Idempotent : si un autre process a déjà seedé, on ignore l'erreur UNIQUE.
      await prisma.expenseType.upsert({
        where: { key: d.key },
        create: { ...d, reimbursementPercent: pct },
        update: {},
      });
    }
  })().catch(err => { seedPromise = null; throw err; });
  return seedPromise;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sanitizePct(v) {
  const n = parseFloat(v);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

async function getExpenseTypes() {
  await ensureSeeded();
  return prisma.expenseType.findMany({ orderBy: { id: 'asc' } });
}

async function createExpenseType({ key, label, reimbursementPercent }) {
  await ensureSeeded();
  const lbl = String(label || '').trim();
  if (!lbl) throw new Error('Libellé requis');
  const slug = slugify(key) || slugify(lbl);
  if (!slug) throw new Error('Slug invalide');
  return prisma.expenseType.create({
    data: { key: slug, label: lbl, reimbursementPercent: sanitizePct(reimbursementPercent) },
  });
}

async function updateExpenseType(id, { key, label, reimbursementPercent }) {
  const data = {};
  if (label !== undefined) {
    const lbl = String(label).trim();
    if (!lbl) throw new Error('Libellé requis');
    data.label = lbl;
  }
  if (key !== undefined) {
    const slug = slugify(key);
    if (!slug) throw new Error('Slug invalide');
    data.key = slug;
  }
  if (reimbursementPercent !== undefined) {
    data.reimbursementPercent = sanitizePct(reimbursementPercent);
  }
  return prisma.expenseType.update({ where: { id }, data });
}

async function deleteExpenseType(id) {
  return prisma.expenseType.delete({ where: { id } });
}

// Calcule le refund effectif d'une note de frais. `types` est le résultat
// de getExpenseTypes (snapshot à passer pour éviter une requête par expense).
function computeRefund(typeKey, amount, types) {
  const t = String(typeKey || '').toLowerCase();
  const arr = types || [];
  const hit = arr.find(x => x.key.toLowerCase() === t);
  if (hit) return (parseFloat(amount) || 0) * (hit.reimbursementPercent / 100);
  // Fallback : type supprimé entre-temps → on applique le % d'"autre" si présent, sinon 0.
  const fallback = arr.find(x => x.key.toLowerCase() === 'autre');
  return (parseFloat(amount) || 0) * ((fallback ? fallback.reimbursementPercent : 0) / 100);
}

module.exports = {
  ensureSeeded,
  getExpenseTypes,
  createExpenseType,
  updateExpenseType,
  deleteExpenseType,
  computeRefund,
  slugify,
};
