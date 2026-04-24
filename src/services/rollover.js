// Fige une semaine close (source de vérité unique pour les calculs hebdos).
// La config (paliers, équivalence points, répartition podium, prix podium,
// remboursements frais/rapat/fourrières) est lue dynamiquement et snapshotée
// sur chaque WeekStats → un changement futur ne réécrit pas l'historique.
const prisma = require('../db');
const { getWeekFromTimestamp, getYearFromTimestamp, getWeekAndYear, weekBounds } = require('./week');
const { getBonusRates } = require('./bonus');
const {
  getTiers, getTierPrimeShares, getPodiumPrizes, getPointsPerGain,
  getBonusMinDeliveries, getWeeklyDeliveryQuota,
  getTier, getShareForRank, getPodiumPrize, computeCollectivePoints,
} = require('./tiers');
const {
  getRepatCostPerEvent, getRepatReimbursementPercent,
  getImpoundCostPerEvent, getImpoundReimbursementPercent,
} = require('./reimbursements');
const { getExpenseTypes, computeRefund: computeExpenseRefund } = require('./expenseTypes');

function normalizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Bornes réelles dim. 18h → dim. 18h pour la semaine ISO (week, year).
// Plus aucune dépendance à `now` → rollover manuel d'une semaine passée reste cohérent.
function periodBoundariesForWeek(week, year) {
  return weekBounds(week, year);
}

// Agrège LogEntry + formulaires pour une semaine donnée (week, year) et renvoie les stats figées par employé.
async function computeFrozenWeek(week, year) {
  const whereWeek = { week, year };
  const [
    logs, employees, specialBonuses, rates,
    tiers, shares, podiumPrizes, pointsPerGain,
    bonusMinDeliveries, weeklyDeliveryQuota,
    expenseTypes, repatCostPerEvent, repatReimbursementPct,
    impoundCostPerEvent, impoundReimbursementPct,
    expenses, repatAgg, breakdownAgg,
  ] = await Promise.all([
    prisma.logEntry.findMany({
      where: { type: 'delivery', ...whereWeek },
      select: { data: true },
    }),
    prisma.employee.findMany(),
    prisma.specialBonus.findMany({ where: whereWeek }),
    getBonusRates(),
    getTiers(),
    getTierPrimeShares(),
    getPodiumPrizes(),
    getPointsPerGain(),
    getBonusMinDeliveries(),
    getWeeklyDeliveryQuota(),
    getExpenseTypes(),
    getRepatCostPerEvent(),
    getRepatReimbursementPercent(),
    getImpoundCostPerEvent(),
    getImpoundReimbursementPercent(),
    prisma.expense.findMany({ where: whereWeek }),
    prisma.repatriation.groupBy({ by: ['employeeId'], where: whereWeek, _count: { _all: true } }),
    prisma.breakdown.groupBy({ by: ['employeeId'], where: whereWeek, _count: { _all: true } }),
  ]);

  const empByKey = new Map();
  for (const e of employees) empByKey.set(normalizeName(e.firstName + ' ' + e.lastName), e);

  const byName = new Map();
  let totalGainEnterprise = 0;
  for (const l of logs) {
    const d = JSON.parse(l.data);
    const name = normalizeName(d[0]);
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, { qtySum: 0, gainEmployee: 0, gainEnterprise: 0 });
    const s = byName.get(name);
    s.qtySum += parseFloat(d[2]) || 0;
    s.gainEmployee += parseFloat(d[3]) || 0;
    const g = parseFloat(d[4]) || 0;
    s.gainEnterprise += g;
    totalGainEnterprise += g;
  }

  // Expense : cumul brut + refund (selon % par type à l'époque)
  const expenseCostMap = new Map();
  const expenseRefundMap = new Map();
  for (const ex of expenses) {
    expenseCostMap.set(ex.employeeId, (expenseCostMap.get(ex.employeeId) || 0) + (ex.amount || 0));
    const refund = computeExpenseRefund(ex.type, ex.amount, expenseTypes);
    expenseRefundMap.set(ex.employeeId, (expenseRefundMap.get(ex.employeeId) || 0) + refund);
  }
  const repatMap = new Map(repatAgg.map(r => [r.employeeId, r._count._all]));
  const breakdownMap = new Map(breakdownAgg.map(r => [r.employeeId, r._count._all]));
  const sbByEmp = new Map(specialBonuses.map(b => [b.employeeId, b]));

  // Employés avec livraisons
  const entries = [];
  for (const [key, s] of byName) {
    const emp = empByKey.get(key);
    if (!emp) continue;
    entries.push({ emp, qtySum: s.qtySum, gainEmployee: s.gainEmployee, gainEnterprise: s.gainEnterprise });
  }
  // + employés sans livraisons mais avec prime spéciale / frais / rapatriements / pannes
  const hasEntryIds = new Set(entries.map(e => e.emp.id));
  for (const emp of employees) {
    if (hasEntryIds.has(emp.id)) continue;
    if (sbByEmp.has(emp.id) || expenseRefundMap.has(emp.id) || repatMap.has(emp.id) || breakdownMap.has(emp.id)) {
      entries.push({ emp, qtySum: 0, gainEmployee: 0, gainEnterprise: 0 });
    }
  }

  entries.sort((a, b) => b.gainEnterprise - a.gainEnterprise);

  const collectivePoints = computeCollectivePoints(totalGainEnterprise, pointsPerGain);
  const collectiveTier = getTier(collectivePoints, tiers);
  const tierLevel = collectiveTier ? collectiveTier.level : 0;
  const tierBasePoints = collectiveTier ? collectiveTier.points : 0;
  const tierBasePrime = collectiveTier ? collectiveTier.prime : 0;

  return entries.map((e, i) => {
    const rank = i + 1;
    const deliveries = Math.round(e.qtySum / 100);
    const share = getShareForRank(rank, shares);
    const tierPrime = tierBasePrime * share;
    const podiumPrize = getPodiumPrize(rank, podiumPrizes);
    const bonusRate = rates[e.emp.role] || 0;
    // Seuil bonus : si atteint, prime = taux% × TOUT le gain entreprise (rétroactif).
    // Sinon 0. Seuil 0 → prime toujours active.
    const unlocked = deliveries >= (bonusMinDeliveries || 0);
    const bonusSalary = unlocked ? e.gainEnterprise * (bonusRate / 100) : 0;
    const sb = sbByEmp.get(e.emp.id);
    const specialBonus = sb ? sb.amount : 0;
    const specialBonusReason = sb ? sb.reason : null;

    const expenseCost = expenseCostMap.get(e.emp.id) || 0;
    const expenseRefund = expenseRefundMap.get(e.emp.id) || 0;

    const repatCount = repatMap.get(e.emp.id) || 0;
    const repatBonus = repatCount * repatCostPerEvent * (repatReimbursementPct / 100);

    const impoundCount = breakdownMap.get(e.emp.id) || 0;
    const impoundGross = impoundCount * impoundCostPerEvent;
    const impoundReimbursement = impoundGross * (impoundReimbursementPct / 100);
    const impoundPenalty = impoundGross - impoundReimbursement;

    const primeFinale = bonusSalary + tierPrime + podiumPrize + specialBonus
                      + expenseRefund + repatBonus - impoundPenalty;
    return {
      employee: e.emp,
      week, year, rank, deliveries, points: collectivePoints,
      gainEmployee: e.gainEmployee, gainEnterprise: e.gainEnterprise,
      bonusSalary, bonusRate, bonusMinDeliveries, weeklyDeliveryQuota,
      tierLevel, tierBasePoints, tierBasePrime, tierPrimeShare: share, pointsPerGain,
      tierPrime,
      podiumPrize, specialBonus, specialBonusReason,
      expenseRefund, expenseCost,
      repatBonus, repatCount, repatCostPerEvent, repatReimbursementPercent: repatReimbursementPct,
      impoundPenalty, impoundCount, impoundCostPerEvent, impoundReimbursementPercent: impoundReimbursementPct,
      impoundReimbursement,
      primeFinale,
    };
  });
}

async function saveFrozenWeek(frozenResults) {
  for (const r of frozenResults) {
    const data = {
      deliveries: r.deliveries,
      gainEmployee: r.gainEmployee,
      gainEnterprise: r.gainEnterprise,
      points: r.points,
      rank: r.rank,
      bonusSalary: r.bonusSalary,
      bonusRate: r.bonusRate,
      bonusMinDeliveries: r.bonusMinDeliveries,
      weeklyDeliveryQuota: r.weeklyDeliveryQuota,
      tierLevel: r.tierLevel,
      tierPrime: r.tierPrime,
      tierBasePoints: r.tierBasePoints,
      tierBasePrime: r.tierBasePrime,
      tierPrimeShare: r.tierPrimeShare,
      pointsPerGain: r.pointsPerGain,
      podiumPrize: r.podiumPrize,
      specialBonus: r.specialBonus,
      specialBonusReason: r.specialBonusReason,
      expenseRefund: r.expenseRefund,
      expenseCost: r.expenseCost,
      repatBonus: r.repatBonus,
      repatCount: r.repatCount,
      repatCostPerEvent: r.repatCostPerEvent,
      repatReimbursementPercent: r.repatReimbursementPercent,
      impoundPenalty: r.impoundPenalty,
      impoundCount: r.impoundCount,
      impoundCostPerEvent: r.impoundCostPerEvent,
      impoundReimbursementPercent: r.impoundReimbursementPercent,
      impoundReimbursement: r.impoundReimbursement,
      primeFinale: r.primeFinale,
    };
    await prisma.weekStats.upsert({
      where: { employeeId_week_year: { employeeId: r.employee.id, week: r.week, year: r.year } },
      create: { employeeId: r.employee.id, week: r.week, year: r.year, ...data },
      update: data,
    });
  }
}

// Fige la semaine qui vient de se terminer (semaine précédente par défaut) + renvoie
// le payload formaté pour que le bot Discord poste les récapitulatifs.
// Gère correctement le passage d'année (ex. S1 2027 après S52 2026).
async function rolloverWeek(opts) {
  opts = opts || {};
  const now = opts.now || new Date();
  const currentWeek = getWeekFromTimestamp(now);
  const currentYear = getYearFromTimestamp(now);

  let endedWeek, endedYear;
  if (opts.week) {
    endedWeek = opts.week;
    endedYear = opts.year || currentYear;
  } else if (currentWeek === 1) {
    // On vient de basculer : la semaine figée est S52 ou S53 de l'année précédente.
    // Point de référence = maintenant - 7j → donne la bonne ISO week-year.
    const ref = new Date(now.getTime() - 7 * 86400000);
    endedWeek = getWeekFromTimestamp(ref);
    endedYear = getYearFromTimestamp(ref);
  } else {
    endedWeek = currentWeek - 1;
    endedYear = currentYear;
  }
  const period = periodBoundariesForWeek(endedWeek, endedYear);

  const frozenResults = await computeFrozenWeek(endedWeek, endedYear);
  await saveFrozenWeek(frozenResults);

  // Payload bot : seulement les employés qui ont un channelId
  const payload = frozenResults
    .filter(r => r.employee.channelId)
    .map(r => ({
      employeeId: r.employee.id,
      name: r.employee.firstName + ' ' + r.employee.lastName,
      discordId: r.employee.discordId,
      channelId: r.employee.channelId,
      iban: r.employee.iban,
      stats: {
        name: r.employee.firstName + ' ' + r.employee.lastName,
        livraisons: r.deliveries,
        gainEmploye: r.gainEmployee,
        prime: r.bonusSalary,
        totalNotesDeFrais: r.expenseRefund,
        totalRapatriements: r.repatBonus,
        totalFourrieres: r.impoundPenalty,
        podiumPlace: r.rank <= 3 ? r.rank : null,
        primePodium: r.podiumPrize,
        primePalier: r.tierPrime,
        palierLevel: r.tierLevel,
        primeFinale: r.primeFinale,
        specialBonus: r.specialBonus,
        specialBonusReason: r.specialBonusReason,
      },
    }));

  return {
    week: endedWeek,
    year: endedYear,
    period: { startDate: period.startDate.toISOString(), endDate: period.endDate.toISOString() },
    frozenCount: frozenResults.length,
    employees: payload,
  };
}

module.exports = { rolloverWeek, computeFrozenWeek, saveFrozenWeek };
