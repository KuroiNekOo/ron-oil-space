// Migration one-shot : unifie ExpenseType + PurchaseType vers le modèle Type.

//
//  - ExpenseType  → Type (par key, déjà un slug) + ExpenseTypeConfig (refund%)
//  - PurchaseType → Type (clé = slugify(name)) + PurchaseTypeConfig
//  - Backfill Purchase.typeKey depuis Purchase.typeId → PurchaseType.name → slug
//
// Cas de chevauchement : si un Type existe déjà pour la clé (parce qu'un
// ExpenseType l'a créé en premier), on n'écrase pas le label/category — on
// ajoute juste la PurchaseTypeConfig manquante. C'est le bénéfice du modèle
// multi-domaine : un même Type peut servir frais ET achats.
//
// Usage : node scripts/migrate-unified-types.js
//
// Idempotent : peut être relancé sans effet de bord. À exécuter APRÈS
// `npx prisma db push` qui aura créé les nouvelles tables.

const prisma = require('../src/db');

function slugify(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip accents (combining marks)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function ensureTypeFromExpense(et) {
  const existing = await prisma.type.findUnique({ where: { key: et.key } });
  if (existing) {
    // Type déjà présent (relance ou créé par un PurchaseType au slug identique).
    // On ne touche pas au label/category : la 1re source fait foi.
    return existing;
  }
  return prisma.type.create({
    data: { key: et.key, label: et.label },
  });
}

async function ensureExpenseConfig(typeId, reimbursementPercent) {
  await prisma.expenseTypeConfig.upsert({
    where: { typeId },
    create: { typeId, reimbursementPercent: reimbursementPercent || 0 },
    update: { reimbursementPercent: reimbursementPercent || 0 },
  });
}

// Auto-catégorisation best-effort à partir du slug. Pour les types connus, on
// pré-remplit `category` afin que les cartes /admin/statistiques s'affichent
// directement après la migration. L'admin peut ajuster via /admin/types.
function inferCategory(key) {
  if (/^vehicul/i.test(key)) return 'VEHICULE';
  if (/^matiere/i.test(key)) return 'MATIERE_PREMIERE';
  if (/^juridiq|^contractuell/i.test(key)) return 'JURIDIQUE';
  return null;
}

async function ensureTypeFromPurchase(pt) {
  const baseKey = slugify(pt.name);
  if (!baseKey) {
    console.warn(`[migrate] PurchaseType #${pt.id} name='${pt.name}' → slug vide, ignoré`);
    return null;
  }
  const existing = await prisma.type.findUnique({ where: { key: baseKey } });
  if (existing) {
    // Merge avec un Type déjà créé (probablement par un ExpenseType homonyme).
    // On laisse le label d'origine. Si la catégorie n'est pas encore définie et
    // que le slug correspond à un bucket connu, on la pose maintenant.
    if (!existing.category) {
      const cat = inferCategory(baseKey);
      if (cat) {
        await prisma.type.update({ where: { id: existing.id }, data: { category: cat } });
        return { ...existing, category: cat };
      }
    }
    return existing;
  }
  return prisma.type.create({
    data: { key: baseKey, label: pt.name, category: inferCategory(baseKey) },
  });
}

async function ensurePurchaseConfig(typeId) {
  await prisma.purchaseTypeConfig.upsert({
    where: { typeId },
    create: { typeId },
    update: {},
  });
}

async function main() {
  console.log('[migrate] début');

  // ── 1. ExpenseType → Type + ExpenseTypeConfig ──
  const expenseTypes = await prisma.expenseType.findMany({ orderBy: { id: 'asc' } });
  console.log(`[migrate] ${expenseTypes.length} ExpenseType(s) à migrer`);
  for (const et of expenseTypes) {
    const t = await ensureTypeFromExpense(et);
    await ensureExpenseConfig(t.id, et.reimbursementPercent);
    console.log(`  · expense ${et.key} (${et.label}, refund ${et.reimbursementPercent}%) → Type #${t.id}`);
  }

  // ── 2. PurchaseType → Type + PurchaseTypeConfig ──
  const purchaseTypes = await prisma.purchaseType.findMany({ orderBy: { id: 'asc' } });
  console.log(`[migrate] ${purchaseTypes.length} PurchaseType(s) à migrer`);
  const ptIdToTypeKey = new Map(); // ancien id PurchaseType → nouvelle key Type, pour le backfill Purchase
  for (const pt of purchaseTypes) {
    const t = await ensureTypeFromPurchase(pt);
    if (!t) continue;
    await ensurePurchaseConfig(t.id);
    ptIdToTypeKey.set(pt.id, t.key);
    const merged = t.label !== pt.name ? ` (merged avec Type existant '${t.label}')` : '';
    console.log(`  · purchase #${pt.id} '${pt.name}' → Type #${t.id} key=${t.key}${merged}`);
  }

  // ── 3. Backfill Purchase.typeKey depuis Purchase.typeId ──
  const purchasesToBackfill = await prisma.purchase.findMany({
    where: { typeKey: null },
    select: { id: true, typeId: true },
  });
  console.log(`[migrate] ${purchasesToBackfill.length} Purchase(s) à backfiller (typeKey null)`);
  let backfilled = 0;
  let orphaned = 0;
  for (const p of purchasesToBackfill) {
    const key = ptIdToTypeKey.get(p.typeId);
    if (!key) {
      orphaned++;
      console.warn(`  · Purchase #${p.id} typeId=${p.typeId} → aucun Type correspondant, laissé en l'état`);
      continue;
    }
    await prisma.purchase.update({ where: { id: p.id }, data: { typeKey: key } });
    backfilled++;
  }
  console.log(`[migrate] Purchase backfillés : ${backfilled}, orphelins : ${orphaned}`);

  console.log('[migrate] terminé.');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
