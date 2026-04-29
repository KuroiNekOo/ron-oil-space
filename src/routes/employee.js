const express = require('express');
const router = express.Router();
const prisma = require('../db');
const { requireEmployee } = require('../middleware/auth');
const { canRapatriement } = require('../services/permissions');
const { getWeekFromTimestamp, getYearFromTimestamp, getWeekAndYear } = require('../services/week');
const { getBonusRates, getBonusRate } = require('../services/bonus');
const { getExpenseTypes, computeRefund: computeExpenseRefund } = require('../services/expenseTypes');
const {
  getRepatCostPerEvent, getRepatReimbursementPercent,
  getImpoundCostPerEvent, getImpoundReimbursementPercent,
} = require('../services/reimbursements');
const {
  getTiers, getTierPrimeShares, getPodiumPrizes, getPointsPerGain,
  getBonusMinDeliveries, getWeeklyDeliveryQuota,
  getTier, getNextTier, getShareForRank, getPodiumPrize,
  computeCollectivePoints,
} = require('../services/tiers');
const { getStoredRecords } = require('../services/records');

function fmt(n) {
  return new Intl.NumberFormat('fr-FR').format(Math.round(n)) + '$';
}

// Semaine ISO courante + année ISO (offset 6h → changement dimanche 18h).
async function getCurrentWeek() {
  return getWeekFromTimestamp(new Date());
}
function getCurrentWeekAndYear() {
  return getWeekAndYear(new Date());
}

async function getEmployee(employeeId) {
  return prisma.employee.findUnique({ where: { id: employeeId } });
}

// ── Agrégation LogEntry → stats employé ──

function normalizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function enrichStat(s, tiers, shares, podiumPrizes, bonusMinDeliveries, bonusRate, specialBonus) {
  const tier = getTier(s.points, tiers);
  const share = getShareForRank(s.rank, shares);
  // Seuil bonus atteint → prime rétroactive sur tout le gain entreprise de la semaine.
  const bonusUnlocked = (s.deliveries || 0) >= (bonusMinDeliveries || 0);
  return {
    ...s,
    tierLevel: tier ? tier.level : 0,
    tierBasePoints: tier ? tier.points : 0,
    tierBasePrime: tier ? tier.prime : 0,
    tierPrimeShare: share,
    tierPrime: tier ? tier.prime * share : 0,
    podiumPrize: getPodiumPrize(s.rank, podiumPrizes),
    bonusSalary: bonusUnlocked ? s.gainEnterprise * ((bonusRate || 0) / 100) : 0,
    bonusRate: bonusRate || 0,
    bonusMinDeliveries: bonusMinDeliveries || 0,
    bonusUnlocked,
    specialBonus: specialBonus ? specialBonus.amount : 0,
    specialBonusReason: specialBonus ? specialBonus.reason : null,
  };
}

// Stats de TOUS les employés pour une semaine donnée (matchés depuis LogEntry type=delivery).
// Retourne un tableau trié par rang (1 = plus gros gainEnterprise).
// Les `points` sont collectifs (totalGainEnterprise / pointsPerGain) → identiques
// pour tous les employés de la semaine : le palier est collectif.
async function computeWeekStats(week, year) {
  const [logs, employees, tiers, shares, podiumPrizes, pointsPerGain, bonusMinDeliveries] = await Promise.all([
    prisma.logEntry.findMany({
      where: { type: 'delivery', week, year },
      select: { data: true },
    }),
    prisma.employee.findMany({ where: { status: 'active' } }),
    getTiers(),
    getTierPrimeShares(),
    getPodiumPrizes(),
    getPointsPerGain(),
    getBonusMinDeliveries(),
  ]);

  const empByKey = new Map();
  for (const e of employees) {
    empByKey.set(normalizeName(e.firstName + ' ' + e.lastName), e);
  }

  // qtySum = somme des % de chaque livraison. Une livraison partagée en deux
  // (ex: 27% + 73%) est comptée comme 1 livraison et pas 2 → aligné avec le jeu.
  // Les livraisons d'employés inactifs ou supprimés sont ignorées (pas comptées
  // dans totalGainEnterprise → n'influencent ni les points collectifs ni le rang).
  const byName = new Map();
  let totalGainEnterprise = 0;
  for (const log of logs) {
    const d = JSON.parse(log.data);
    const key = normalizeName(d[0]);
    if (!key) continue;
    if (!empByKey.has(key)) continue;
    if (!byName.has(key)) byName.set(key, { qtySum: 0, gainEmployee: 0, gainEnterprise: 0 });
    const s = byName.get(key);
    s.qtySum += parseFloat(d[2]) || 0;
    s.gainEmployee += parseFloat(d[3]) || 0;
    const g = parseFloat(d[4]) || 0;
    s.gainEnterprise += g;
    totalGainEnterprise += g;
  }
  const collectivePoints = computeCollectivePoints(totalGainEnterprise, pointsPerGain);

  const stats = [];
  const matchedEmpIds = new Set();
  for (const [key, s] of byName) {
    const emp = empByKey.get(key);
    matchedEmpIds.add(emp.id);
    const deliveries = Math.round(s.qtySum / 100);
    stats.push({
      employeeId: emp.id,
      employee: emp,
      week,
      deliveries,
      gainEmployee: s.gainEmployee,
      gainEnterprise: s.gainEnterprise,
      points: collectivePoints,
    });
  }
  // Tous les employés actifs sans livraison apparaissent à 0 dans le classement.
  for (const emp of employees) {
    if (matchedEmpIds.has(emp.id)) continue;
    stats.push({
      employeeId: emp.id,
      employee: emp,
      week,
      deliveries: 0,
      gainEmployee: 0,
      gainEnterprise: 0,
      points: collectivePoints,
    });
  }

  // Tri : contributifs d'abord (par gainEnterprise desc), zéros ensuite (ordre stable).
  // Rang attribué uniquement aux contributifs ; rang = 0 = non classé (pas de podium,
  // pas de part de tier prime via getPodiumPrize/getShareForRank).
  stats.sort((a, b) => b.gainEnterprise - a.gainEnterprise);
  let nextRank = 1;
  stats.forEach((s) => { s.rank = s.gainEnterprise > 0 ? nextRank++ : 0; });

  const rates = await getBonusRates();
  const empIds = stats.map(s => s.employeeId);
  const bonuses = empIds.length
    ? await prisma.specialBonus.findMany({ where: { week, year, employeeId: { in: empIds } } })
    : [];
  const bonusByEmp = new Map(bonuses.map(b => [b.employeeId, b]));

  const enriched = stats.map(s => {
    const b = bonusByEmp.get(s.employeeId);
    return enrichStat(s, tiers, shares, podiumPrizes, bonusMinDeliveries, rates[s.employee.role], b);
  });
  enriched._collectivePoints = collectivePoints;
  enriched._totalGainEnterprise = totalGainEnterprise;
  enriched._podiumPrizes = podiumPrizes;
  enriched._bonusMinDeliveries = bonusMinDeliveries;
  return enriched;
}

// ─── GET /dashboard ───
router.get('/dashboard', requireEmployee, async (req, res) => {
  try {
    const { week: currentWeek, year: currentYear } = getCurrentWeekAndYear();
    const employee = await getEmployee(req.session.employeeId);
    if (!employee) return res.redirect('/login');

    const [
      leaderboard, records, tiers, shares, podiumPrizes, weeklyDeliveryQuota,
      expenseTypes, repatCost, repatPct, impoundCost, impoundPct,
      myExpenses, myRepatCount, myImpoundCount,
    ] = await Promise.all([
      computeWeekStats(currentWeek, currentYear),
      getStoredRecords(),
      getTiers(),
      getTierPrimeShares(),
      getPodiumPrizes(),
      getWeeklyDeliveryQuota(),
      getExpenseTypes(),
      getRepatCostPerEvent(),
      getRepatReimbursementPercent(),
      getImpoundCostPerEvent(),
      getImpoundReimbursementPercent(),
      prisma.expense.findMany({
        where: { employeeId: employee.id, week: currentWeek, year: currentYear },
      }),
      prisma.repatriation.count({
        where: { employeeId: employee.id, week: currentWeek, year: currentYear },
      }),
      prisma.breakdown.count({
        where: { employeeId: employee.id, week: currentWeek, year: currentYear },
      }),
    ]);

    const collectivePoints = leaderboard._collectivePoints || 0;
    const bonusMinDeliveries = leaderboard._bonusMinDeliveries || 0;
    const myStat = leaderboard.find(l => l.employeeId === employee.id);
    let stats;
    if (myStat) {
      stats = myStat;
    } else {
      const myBonus = await prisma.specialBonus.findUnique({
        where: { employeeId_week_year: { employeeId: employee.id, week: currentWeek, year: currentYear } },
      });
      // Employé sans livraison : il voit quand même le palier collectif de la semaine.
      stats = {
        deliveries: 0, gainEmployee: 0, gainEnterprise: 0,
        points: collectivePoints,
        rank: 0, bonusSalary: 0,
        tierLevel: 0, tierBasePoints: 0, tierBasePrime: 0, tierPrimeShare: 0,
        tierPrime: 0, podiumPrize: 0,
        bonusRate: await getBonusRate(employee.role),
        bonusMinDeliveries,
        bonusUnlocked: bonusMinDeliveries === 0,
        specialBonus: myBonus ? myBonus.amount : 0,
        specialBonusReason: myBonus ? myBonus.reason : null,
      };
    }

    // Breakdown live : notes de frais / rapatriements / fourrières (taux courants).
    const expenseCost = myExpenses.reduce((s, e) => s + (e.amount || 0), 0);
    const expenseRefund = myExpenses.reduce((s, e) => s + computeExpenseRefund(e.type, e.amount, expenseTypes), 0);
    const repatBonus = myRepatCount * repatCost * (repatPct / 100);
    const impoundGross = myImpoundCount * impoundCost;
    const impoundReimbursement = impoundGross * (impoundPct / 100);
    const impoundPenalty = impoundGross - impoundReimbursement;
    stats = {
      ...stats,
      expenseCost, expenseRefund,
      repatCount: myRepatCount, repatCostPerEvent: repatCost, repatReimbursementPercent: repatPct, repatBonus,
      impoundCount: myImpoundCount, impoundCostPerEvent: impoundCost, impoundReimbursementPercent: impoundPct,
      impoundReimbursement, impoundPenalty,
    };

    const totalDeliveriesThisWeek = leaderboard.reduce((s, l) => s + l.deliveries, 0);

    const podium = leaderboard
      .filter(l => l.rank >= 1 && l.rank <= 3)
      .map(l => ({
        rank: l.rank,
        name: l.employee.firstName + ' ' + l.employee.lastName,
        deliveries: l.deliveries,
      }));
    const podiumDisplay = [];
    const p2 = podium.find(p => p.rank === 2);
    const p1 = podium.find(p => p.rank === 1);
    const p3 = podium.find(p => p.rank === 3);
    if (p2) podiumDisplay.push(p2);
    if (p1) podiumDisplay.push(p1);
    if (p3) podiumDisplay.push(p3);

    const tier = getTier(collectivePoints, tiers);
    const nextTier = getNextTier(collectivePoints, tiers);

    res.render('employee/dashboard', {
      employee,
      currentWeek,
      stats,
      leaderboard,
      tiers,
      tier,
      nextTier,
      totalPlayers: leaderboard.length,
      totalDeliveries: totalDeliveriesThisWeek,
      companyRecord: records.companyRecord.value,
      individualRecord: {
        value: records.individualRecord.value,
        name: records.individualRecord.name,
      },
      podium: podiumDisplay,
      weeklyDeliveryQuota,
      bonusMinDeliveries,
      getTierPrimeShare: (rank) => {
        const s = getShareForRank(rank, shares);
        return s > 0 ? s : null;
      },
      getPodiumPrize: (rank) => getPodiumPrize(rank, podiumPrizes),
      fmt,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Erreur serveur');
  }
});

// ─── GET /profil ───
// Page centrée sur l'historique figé — la semaine en cours est sur /dashboard.
router.get('/profil', requireEmployee, async (req, res) => {
  try {
    const { week: currentWeek, year: currentYear } = getCurrentWeekAndYear();
    const employee = await getEmployee(req.session.employeeId);
    if (!employee) return res.redirect('/login');

    const frozen = await prisma.weekStats.findMany({
      where: {
        employeeId: employee.id,
        NOT: { AND: [{ week: currentWeek }, { year: currentYear }] },
      },
      orderBy: [{ year: 'desc' }, { week: 'desc' }],
    });

    res.render('employee/profil', {
      employee,
      currentWeek,
      history: frozen,
      fmt,
    });
  } catch (err) {
    console.error('Profil error:', err);
    res.status(500).send('Erreur serveur');
  }
});

// ─── GET /classement ───
router.get('/classement', requireEmployee, async (req, res) => {
  try {
    const { week: currentWeek, year: currentYear } = getCurrentWeekAndYear();
    const employee = await getEmployee(req.session.employeeId);
    if (!employee) return res.redirect('/login');

    const leaderboard = await computeWeekStats(currentWeek, currentYear);

    res.render('employee/classement', {
      employee,
      currentWeek,
      leaderboard,
    });
  } catch (err) {
    console.error('Classement error:', err);
    res.status(500).send('Erreur serveur');
  }
});

// ─── GET/POST /absences ───
router.get('/absences', requireEmployee, async (req, res) => {
  const { week: currentWeek, year: currentYear } = getCurrentWeekAndYear();
  const employee = await getEmployee(req.session.employeeId);
  if (!employee) return res.redirect('/login');
  res.render('employee/absences', {
    employee, currentWeek, success: req.query.success || null
  });
});

router.post('/absences', requireEmployee, async (req, res) => {
  try {
    const { week: currentWeek, year: currentYear } = getCurrentWeekAndYear();
    const { dateStart, dateEnd, type, justificatif, comment } = req.body;
    await prisma.absence.create({
      data: {
        employeeId: req.session.employeeId,
        employeeFirstName: req.employee.firstName,
        employeeLastName: req.employee.lastName,
        week: currentWeek,
        year: currentYear,
        type,
        dateStart: new Date(dateStart),
        dateEnd: new Date(dateEnd),
        justificatif: justificatif || null,
        comment: comment || null
      }
    });
    res.redirect('/absences?success=1');
  } catch (err) {
    console.error('Absence error:', err);
    res.status(500).send('Erreur serveur');
  }
});

// ─── GET/POST /frais ───
router.get('/frais', requireEmployee, async (req, res) => {
  const { week: currentWeek, year: currentYear } = getCurrentWeekAndYear();
  const employee = await getEmployee(req.session.employeeId);
  if (!employee) return res.redirect('/login');
  const expenseTypes = await getExpenseTypes();
  res.render('employee/frais', {
    employee, currentWeek, expenseTypes, success: req.query.success || null
  });
});

router.post('/frais', requireEmployee, async (req, res) => {
  try {
    const { week: currentWeek, year: currentYear } = getCurrentWeekAndYear();
    const { type, montant, comment } = req.body;
    await prisma.expense.create({
      data: {
        employeeId: req.session.employeeId,
        employeeFirstName: req.employee.firstName,
        employeeLastName: req.employee.lastName,
        week: currentWeek,
        year: currentYear,
        type,
        amount: parseFloat(montant),
        comment: comment || null
      }
    });
    res.redirect('/frais?success=1');
  } catch (err) {
    console.error('Frais error:', err);
    res.status(500).send('Erreur serveur');
  }
});

// ─── GET/POST /pannes ───
router.get('/pannes', requireEmployee, async (req, res) => {
  const { week: currentWeek, year: currentYear } = getCurrentWeekAndYear();
  const employee = await getEmployee(req.session.employeeId);
  if (!employee) return res.redirect('/login');
  const vehicles = await prisma.vehicle.findMany({
    where: { status: 'active' },
    orderBy: { plate: 'asc' },
  });
  const trucks = vehicles.filter(v => v.type === 'Camion');
  const tankers = vehicles.filter(v => v.type === 'Citerne');
  res.render('employee/pannes', {
    employee, currentWeek, trucks, tankers, success: req.query.success || null
  });
});

router.post('/pannes', requireEmployee, async (req, res) => {
  try {
    const { week: currentWeek, year: currentYear } = getCurrentWeekAndYear();
    const { plaqueCamion, plaqueCiterne, type, position, comment } = req.body;
    await prisma.breakdown.create({
      data: {
        employeeId: req.session.employeeId,
        employeeFirstName: req.employee.firstName,
        employeeLastName: req.employee.lastName,
        week: currentWeek,
        year: currentYear,
        truckPlate: plaqueCamion || null,
        tankerPlate: plaqueCiterne || null,
        type: type || null,
        position: position || null,
        comment: comment || null
      }
    });
    res.redirect('/pannes?success=1');
  } catch (err) {
    console.error('Pannes error:', err);
    res.status(500).send('Erreur serveur');
  }
});

// ─── GET/POST /rapatriements ───
// Accès dépend du flag canRapatriement défini par rôle dans /admin/roles.
async function requireRapatriementAccess(req, res, next) {
  const emp = await prisma.employee.findUnique({
    where: { id: req.session.employeeId },
    select: { role: true },
  });
  if (!emp || !(await canRapatriement(emp.role))) {
    return res.redirect('/dashboard');
  }
  next();
}

router.get('/rapatriements', requireEmployee, requireRapatriementAccess, async (req, res) => {
  const { week: currentWeek, year: currentYear } = getCurrentWeekAndYear();
  const employee = await getEmployee(req.session.employeeId);
  if (!employee) return res.redirect('/login');
  const vehicles = await prisma.vehicle.findMany({
    where: { status: 'active' },
    orderBy: { plate: 'asc' },
  });
  const trucks = vehicles.filter(v => v.type === 'Camion');
  const tankers = vehicles.filter(v => v.type === 'Citerne');
  res.render('employee/rapatriements', {
    employee, currentWeek, trucks, tankers, success: req.query.success || null
  });
});

router.post('/rapatriements', requireEmployee, requireRapatriementAccess, async (req, res) => {
  try {
    const { week: currentWeek, year: currentYear } = getCurrentWeekAndYear();
    const { plaqueCamion, plaqueCiterne, fuel, departure, comment } = req.body;
    const fuelNum = parseInt(fuel);
    await prisma.repatriation.create({
      data: {
        employeeId: req.session.employeeId,
        employeeFirstName: req.employee.firstName,
        employeeLastName: req.employee.lastName,
        week: currentWeek,
        year: currentYear,
        truckPlate: plaqueCamion || null,
        tankerPlate: plaqueCiterne || null,
        fuel: isFinite(fuelNum) ? fuelNum : null,
        departure: departure || null,
        comment: comment || null
      }
    });
    res.redirect('/rapatriements?success=1');
  } catch (err) {
    console.error('Rapatriements error:', err);
    res.status(500).send('Erreur serveur');
  }
});

module.exports = router;
