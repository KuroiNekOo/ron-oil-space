// Config des paliers : grille (level/points/prime), équivalence $→pts,
// répartition de la prime palier sur le podium. Tout est modifiable en admin.
// Les valeurs par défaut sont appliquées si les Config entries n'existent pas encore.
const prisma = require('../db');

const DEFAULT_TIERS = [
  { level: 1, points: 30,  prime: 1500  },
  { level: 2, points: 60,  prime: 3500  },
  { level: 3, points: 100, prime: 7500  },
  { level: 4, points: 150, prime: 10000 },
  { level: 5, points: 200, prime: 12500 },
  { level: 6, points: 250, prime: 15000 },
  { level: 7, points: 350, prime: 17500 },
];
const DEFAULT_SHARES = { 1: 0.50, 2: 0.30, 3: 0.20 };
const DEFAULT_PODIUM_PRIZES = { 1: 3000, 2: 2000, 3: 1000 };
const DEFAULT_POINTS_PER_GAIN = 1000;
const DEFAULT_BONUS_MIN_DELIVERIES = 0;
const DEFAULT_WEEKLY_DELIVERY_QUOTA = 30;

async function getConfigJson(key, fallback) {
  const row = await prisma.config.findUnique({ where: { key } });
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

async function setConfigJson(key, value) {
  await prisma.config.upsert({
    where: { key },
    create: { key, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  });
}

function sanitizeTiers(tiers) {
  return (Array.isArray(tiers) ? tiers : [])
    .map((t, i) => ({
      level: parseInt(t.level) || (i + 1),
      points: parseInt(t.points) || 0,
      prime: parseFloat(t.prime) || 0,
    }))
    .filter(t => t.level > 0)
    .sort((a, b) => a.level - b.level);
}

async function getTiers() {
  const t = await getConfigJson('tiers', DEFAULT_TIERS);
  const clean = sanitizeTiers(t);
  return clean.length > 0 ? clean : [...DEFAULT_TIERS];
}

async function setTiers(tiers) {
  const clean = sanitizeTiers(tiers);
  await setConfigJson('tiers', clean);
  return clean;
}

function sanitizeShares(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    const rank = parseInt(k);
    if (!rank || rank < 1) continue;
    const v = parseFloat(obj[k]);
    if (isNaN(v) || v < 0) continue;
    out[rank] = v;
  }
  return out;
}

async function getTierPrimeShares() {
  const s = await getConfigJson('tierPrimeShares', DEFAULT_SHARES);
  const clean = sanitizeShares(s);
  return Object.keys(clean).length ? clean : { ...DEFAULT_SHARES };
}

async function setTierPrimeShares(shares) {
  const clean = sanitizeShares(shares);
  await setConfigJson('tierPrimeShares', clean);
  return clean;
}

function sanitizePodiumPrizes(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    const rank = parseInt(k);
    if (!rank || rank < 1) continue;
    const v = parseFloat(obj[k]);
    if (!isFinite(v) || v < 0) continue;
    out[rank] = v;
  }
  return out;
}

async function getPodiumPrizes() {
  const p = await getConfigJson('podiumPrizes', DEFAULT_PODIUM_PRIZES);
  const clean = sanitizePodiumPrizes(p);
  return Object.keys(clean).length ? clean : { ...DEFAULT_PODIUM_PRIZES };
}

async function setPodiumPrizes(prizes) {
  const clean = sanitizePodiumPrizes(prizes);
  await setConfigJson('podiumPrizes', clean);
  return clean;
}

function getPodiumPrize(rank, prizes) {
  if (rank == null) return 0;
  return prizes[rank] ?? prizes[String(rank)] ?? 0;
}

async function getPointsPerGain() {
  const row = await prisma.config.findUnique({ where: { key: 'pointsPerGain' } });
  if (!row) return DEFAULT_POINTS_PER_GAIN;
  const n = parseFloat(row.value);
  return !isFinite(n) || n <= 0 ? DEFAULT_POINTS_PER_GAIN : n;
}

async function setPointsPerGain(n) {
  const v = parseFloat(n);
  if (!isFinite(v) || v <= 0) throw new Error('pointsPerGain doit être > 0');
  await prisma.config.upsert({
    where: { key: 'pointsPerGain' },
    create: { key: 'pointsPerGain', value: String(v) },
    update: { value: String(v) },
  });
  return v;
}

async function getScalarInt(key, fallback, minValue) {
  const row = await prisma.config.findUnique({ where: { key } });
  if (!row) return fallback;
  const n = parseInt(row.value);
  if (!isFinite(n) || n < (minValue ?? 0)) return fallback;
  return n;
}

async function setScalarInt(key, n, minValue) {
  const v = parseInt(n);
  const min = minValue ?? 0;
  if (!isFinite(v) || v < min) throw new Error(`${key} doit être un entier >= ${min}`);
  await prisma.config.upsert({
    where: { key },
    create: { key, value: String(v) },
    update: { value: String(v) },
  });
  return v;
}

// Seuil minimum de livraisons pour débloquer la prime de livraisons.
// Si atteint, le taux s'applique rétroactivement sur TOUT le gain entreprise de la semaine.
// 0 = pas de seuil (prime toujours active).
async function getBonusMinDeliveries() {
  return getScalarInt('bonusMinDeliveries', DEFAULT_BONUS_MIN_DELIVERIES, 0);
}
async function setBonusMinDeliveries(n) {
  return setScalarInt('bonusMinDeliveries', n, 0);
}

// Quota d'affichage des livraisons hebdo (purement informatif sur le dashboard employé).
async function getWeeklyDeliveryQuota() {
  return getScalarInt('weeklyDeliveryQuota', DEFAULT_WEEKLY_DELIVERY_QUOTA, 1);
}
async function setWeeklyDeliveryQuota(n) {
  return setScalarInt('weeklyDeliveryQuota', n, 1);
}

function getTier(points, tiers) {
  let t = null;
  for (const tier of tiers) if (points >= tier.points) t = tier;
  return t;
}

function getNextTier(points, tiers) {
  return tiers.find(t => points < t.points) || null;
}

function getShareForRank(rank, shares) {
  if (rank == null) return 0;
  return shares[rank] ?? shares[String(rank)] ?? 0;
}

function computeCollectivePoints(totalGainEnterprise, pointsPerGain) {
  const pp = pointsPerGain || DEFAULT_POINTS_PER_GAIN;
  return Math.floor((totalGainEnterprise || 0) / pp);
}

module.exports = {
  DEFAULT_TIERS, DEFAULT_SHARES, DEFAULT_PODIUM_PRIZES, DEFAULT_POINTS_PER_GAIN,
  DEFAULT_BONUS_MIN_DELIVERIES, DEFAULT_WEEKLY_DELIVERY_QUOTA,
  getTiers, setTiers,
  getTierPrimeShares, setTierPrimeShares,
  getPodiumPrizes, setPodiumPrizes, getPodiumPrize,
  getPointsPerGain, setPointsPerGain,
  getBonusMinDeliveries, setBonusMinDeliveries,
  getWeeklyDeliveryQuota, setWeeklyDeliveryQuota,
  getTier, getNextTier, getShareForRank,
  computeCollectivePoints,
};
