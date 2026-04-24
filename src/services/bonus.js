// Taux de prime de livraison par rôle, stockés en Config sous la clé `bonusRate.<Rôle>`.
// Si un rôle n'a pas de valeur définie, getBonusRate retourne 0 (pas de prime).
const prisma = require('../db');
const PREFIX = 'bonusRate.';

async function getBonusRates() {
  const configs = await prisma.config.findMany({
    where: { key: { startsWith: PREFIX } },
  });
  const rates = {};
  for (const c of configs) {
    rates[c.key.substring(PREFIX.length)] = parseFloat(c.value) || 0;
  }
  return rates;
}

async function getBonusRate(role) {
  if (!role) return 0;
  const c = await prisma.config.findUnique({ where: { key: PREFIX + role } });
  return c ? parseFloat(c.value) || 0 : 0;
}

async function setBonusRate(role, rate) {
  const key = PREFIX + role;
  const value = String(parseFloat(rate) || 0);
  await prisma.config.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

module.exports = { getBonusRates, getBonusRate, setBonusRate, PREFIX };
