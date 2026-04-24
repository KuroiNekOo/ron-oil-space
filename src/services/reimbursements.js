// Config pour rapatriements et fourrières. Les % et montants par évènement sont
// toujours snapshotés dans WeekStats au rollover → un changement futur ne
// recalcule pas l'historique.
// Note : les types de notes de frais ont leur propre table (voir expenseTypes.js).
const prisma = require('../db');

const DEFAULT_REPAT_COST = 400;
const DEFAULT_REPAT_REIMBURSEMENT_PCT = 100;
const DEFAULT_IMPOUND_COST = 280;
const DEFAULT_IMPOUND_REIMBURSEMENT_PCT = 0;

async function getScalar(key, fallback) {
  const row = await prisma.config.findUnique({ where: { key } });
  if (!row) return fallback;
  const n = parseFloat(row.value);
  return isFinite(n) ? n : fallback;
}

async function setScalar(key, value, { min = 0, max = Infinity } = {}) {
  const v = parseFloat(value);
  if (!isFinite(v) || v < min || v > max) {
    throw new Error(`${key} doit être entre ${min} et ${max}`);
  }
  await prisma.config.upsert({
    where: { key },
    create: { key, value: String(v) },
    update: { value: String(v) },
  });
  return v;
}

async function getRepatCostPerEvent() { return getScalar('repatCostPerEvent', DEFAULT_REPAT_COST); }
async function setRepatCostPerEvent(v) { return setScalar('repatCostPerEvent', v); }

async function getRepatReimbursementPercent() {
  return getScalar('repatReimbursementPercent', DEFAULT_REPAT_REIMBURSEMENT_PCT);
}
async function setRepatReimbursementPercent(v) {
  return setScalar('repatReimbursementPercent', v, { min: 0, max: 100 });
}

async function getImpoundCostPerEvent() { return getScalar('impoundCostPerEvent', DEFAULT_IMPOUND_COST); }
async function setImpoundCostPerEvent(v) { return setScalar('impoundCostPerEvent', v); }

async function getImpoundReimbursementPercent() {
  return getScalar('impoundReimbursementPercent', DEFAULT_IMPOUND_REIMBURSEMENT_PCT);
}
async function setImpoundReimbursementPercent(v) {
  return setScalar('impoundReimbursementPercent', v, { min: 0, max: 100 });
}

module.exports = {
  DEFAULT_REPAT_COST,
  DEFAULT_REPAT_REIMBURSEMENT_PCT,
  DEFAULT_IMPOUND_COST,
  DEFAULT_IMPOUND_REIMBURSEMENT_PCT,
  getRepatCostPerEvent, setRepatCostPerEvent,
  getRepatReimbursementPercent, setRepatReimbursementPercent,
  getImpoundCostPerEvent, setImpoundCostPerEvent,
  getImpoundReimbursementPercent, setImpoundReimbursementPercent,
};
