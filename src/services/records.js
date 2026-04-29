// Records "tous temps" (record commun + record individuel) figés en BDD pour
// l'affichage du dashboard employé.
//
// Source de vérité : LogEntry type=delivery exclusivement. Aucun filtre sur le
// statut ou l'existence de l'employé → un employé désactivé / supprimé continue
// de détenir le record tant qu'il n'a pas été battu.
//
// Persisté dans Config sous la clé `records` (JSON unique pour atomicité). Le
// scheduler côté alerts.js rafraîchit périodiquement (défaut 60 min).

const prisma = require('../db');

const CONFIG_KEY = 'records';

function normalizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Scanne tous les LogEntry type=delivery et calcule les 2 records.
// - companyRecord : max de Σ qty par (year, week)
// - individualRecord : max de Σ qty par (employé, year, week), nom = libellé brut
//   (snapshot du log, donc valable même si l'employé n'existe plus en BDD)
async function computeRecords() {
  const logs = await prisma.logEntry.findMany({
    where: { type: 'delivery' },
    select: { data: true, week: true, year: true },
  });

  const weekQty = new Map();        // "year|week" → qtySum
  const empWeekQty = new Map();     // "normName|year|week" → qtySum
  const displayName = new Map();    // normName → libellé d'affichage (premier rencontré)

  for (const log of logs) {
    let d;
    try { d = JSON.parse(log.data); } catch { continue; }
    const rawName = (d[0] || '').trim();
    if (!rawName) continue;
    const norm = normalizeName(rawName);
    if (!displayName.has(norm)) displayName.set(norm, rawName);

    const q = parseFloat(d[2]) || 0;
    if (q <= 0) continue;

    const wk = log.year + '|' + log.week;
    weekQty.set(wk, (weekQty.get(wk) || 0) + q);

    const k = norm + '|' + wk;
    empWeekQty.set(k, (empWeekQty.get(k) || 0) + q);
  }

  let companyValue = 0;
  let companyKey = null;
  for (const [k, q] of weekQty) {
    if (q > companyValue) { companyValue = q; companyKey = k; }
  }

  let individualValue = 0;
  let individualKey = null;
  for (const [k, q] of empWeekQty) {
    if (q > individualValue) { individualValue = q; individualKey = k; }
  }

  const company = companyKey ? (() => {
    const [year, week] = companyKey.split('|').map(Number);
    return { value: Math.round(companyValue / 100), week, year };
  })() : { value: 0, week: null, year: null };

  const individual = individualKey ? (() => {
    const [norm, year, week] = individualKey.split('|');
    return {
      value: Math.round(individualValue / 100),
      name: displayName.get(norm) || norm,
      week: Number(week),
      year: Number(year),
    };
  })() : { value: 0, name: '—', week: null, year: null };

  return {
    companyRecord: company,
    individualRecord: individual,
    computedAt: new Date().toISOString(),
  };
}

async function refreshRecords() {
  const records = await computeRecords();
  await prisma.config.upsert({
    where: { key: CONFIG_KEY },
    create: { key: CONFIG_KEY, value: JSON.stringify(records) },
    update: { value: JSON.stringify(records) },
  });
  return records;
}

// Lit les records figés. Si la Config est absente (premier run), calcule + persiste.
async function getStoredRecords() {
  const row = await prisma.config.findUnique({ where: { key: CONFIG_KEY } });
  if (!row) return refreshRecords();
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || !parsed.companyRecord || !parsed.individualRecord) return refreshRecords();
    return parsed;
  } catch {
    return refreshRecords();
  }
}

module.exports = { computeRecords, refreshRecords, getStoredRecords };
