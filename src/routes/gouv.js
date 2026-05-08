const express = require('express');
const router = express.Router();
const prisma = require('../db');
const { requireGov } = require('../middleware/auth');
const { getGovAccount } = require('../services/govAccount');
const { getWeekAndYear } = require('../services/week');
const { computeFrozenWeek } = require('../services/rollover');

// ── Login Gouvernement ──

router.get('/login', (req, res) => {
  if (req.session && req.session.govId) return res.redirect('/gouv/effectifs');
  res.render('gouv-login', { error: req.query.error });
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.redirect('/gouv/login?error=1');
    }

    const account = await getGovAccount();
    if (!account) return res.redirect('/gouv/login?error=1');

    if (account.username !== username || account.password !== password) {
      return res.redirect('/gouv/login?error=1');
    }

    // On remet à zéro toute session admin/employé qui traînerait : un seul
    // contexte d'auth à la fois.
    req.session.userId = undefined;
    req.session.employeeId = undefined;
    req.session.isAdmin = undefined;
    req.session.employeeName = undefined;
    req.session.govId = account.id;

    res.redirect('/gouv/effectifs');
  } catch (err) {
    console.error('Gouv login error:', err);
    res.redirect('/gouv/login?error=1');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/gouv/login'));
});

// ── Panel (lecture seule) ──

router.use(requireGov);

router.get('/', (req, res) => res.redirect('/gouv/effectifs'));

router.get('/effectifs', async (req, res) => {
  try {
    // Vue gouvernement : effectifs déclarés publiquement seulement.
    // Mêmes critères que /equipe (status active + showInTeam) → un employé exclu
    // de la vitrine partenaires l'est aussi du panel gouv.
    const where = { status: 'active', showInTeam: true };
    const employees = await prisma.employee.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });

    const counters = {
      total: employees.length,
      cdi: employees.filter(e => e.contract === 'CDI').length,
      cdd: employees.filter(e => e.contract === 'CDD').length,
    };

    res.render('gouv/effectifs', { employees, counters });
  } catch (err) {
    console.error('GET /gouv/effectifs error:', err);
    res.status(500).send('Erreur serveur');
  }
});

const LIST_PAGE_SIZE = 100;

router.get('/achats', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);

    const where = q ? {
      OR: [
        { description: { contains: q } },
        { type: { name: { contains: q } } },
        { employeeFirstName: { contains: q } },
        { employeeLastName: { contains: q } },
      ],
    } : {};

    const { week: currentWeek, year: currentYear } = getWeekAndYear(new Date());

    const [purchases, totalFiltered, allTotalsRows, weekTotalsRows, totalCount] = await Promise.all([
      prisma.purchase.findMany({
        where,
        include: { type: true, employee: true },
        orderBy: { id: 'desc' },
        skip: (page - 1) * LIST_PAGE_SIZE,
        take: LIST_PAGE_SIZE,
      }),
      prisma.purchase.count({ where }),
      prisma.purchase.findMany({ select: { qty: true, unitPrice: true } }),
      prisma.purchase.findMany({
        where: { week: currentWeek, date: { gte: new Date(currentYear, 0, 1), lt: new Date(currentYear + 1, 0, 1) } },
        select: { qty: true, unitPrice: true },
      }),
      prisma.purchase.count(),
    ]);

    const counters = {
      total: totalCount,
      totalSpent: allTotalsRows.reduce((s, a) => s + a.qty * a.unitPrice, 0),
      weekTotal: weekTotalsRows.reduce((s, a) => s + a.qty * a.unitPrice, 0),
    };

    const totalPages = Math.max(1, Math.ceil(totalFiltered / LIST_PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    const pageOffset = (safePage - 1) * LIST_PAGE_SIZE;

    res.render('gouv/achats', {
      purchases, currentWeek, counters,
      page: safePage, totalPages, total: totalFiltered, pageOffset,
      query: { q },
    });
  } catch (err) {
    console.error('GET /gouv/achats error:', err);
    res.status(500).send('Erreur serveur');
  }
});

// Reproduction de la logique de /admin/statistiques pour la version Gouvernement
// (lecture seule). Même format de données pour rester aligné si on ajuste la
// formule côté admin plus tard.
function sumWeekStats(rows) {
  let livraisons = 0, gainEnterprise = 0, gainEmployee = 0;
  let bonusSalary = 0, tierPrime = 0, podiumPrize = 0, specialBonus = 0;
  let expenseRefund = 0, repatBonus = 0, impoundReimbursement = 0;
  let impoundPenalty = 0, expenseCost = 0, primeFinale = 0;
  for (const r of rows) {
    livraisons    += r.deliveries || 0;
    gainEnterprise += r.gainEnterprise || 0;
    gainEmployee   += r.gainEmployee || 0;
    bonusSalary    += r.bonusSalary || 0;
    tierPrime      += r.tierPrime || 0;
    podiumPrize    += r.podiumPrize || 0;
    specialBonus   += r.specialBonus || 0;
    expenseRefund  += r.expenseRefund || 0;
    expenseCost    += r.expenseCost || 0;
    repatBonus     += r.repatBonus || 0;
    impoundReimbursement += r.impoundReimbursement || 0;
    impoundPenalty += r.impoundPenalty || 0;
    primeFinale    += r.primeFinale || 0;
  }
  const totalPrimes = bonusSalary + tierPrime + podiumPrize + specialBonus;
  const totalFrais  = expenseRefund + repatBonus + impoundReimbursement;
  return {
    livraisons, gainEnterprise, gainEmployee,
    bonusSalary, tierPrime, podiumPrize, specialBonus, totalPrimes,
    expenseRefund, expenseCost, repatBonus, impoundReimbursement, totalFrais,
    impoundPenalty, primeFinale,
    activeEmployees: rows.length,
  };
}

router.get('/statistiques', async (req, res) => {
  try {
    const { week: currentWeek, year: currentYear } = getWeekAndYear(new Date());

    const [liveRows, allFrozen, allPurchases] = await Promise.all([
      computeFrozenWeek(currentWeek, currentYear),
      prisma.weekStats.findMany({
        where: { NOT: { AND: [{ week: currentWeek }, { year: currentYear }] } },
        include: { employee: true },
        orderBy: [{ year: 'desc' }, { week: 'desc' }],
      }),
      prisma.purchase.findMany({ select: { date: true, qty: true, unitPrice: true } }),
    ]);

    const purchasesByWeek = new Map();
    for (const p of allPurchases) {
      const { week, year } = getWeekAndYear(p.date);
      const k = year + '|' + week;
      purchasesByWeek.set(k, (purchasesByWeek.get(k) || 0) + (p.qty || 0) * (p.unitPrice || 0));
    }

    const liveTop = liveRows.slice().sort((a, b) => b.gainEnterprise - a.gainEnterprise);
    const currentTotals = sumWeekStats(liveRows);
    currentTotals.achats = purchasesByWeek.get(currentYear + '|' + currentWeek) || 0;
    currentTotals.totalDepenses =
      currentTotals.totalPrimes + currentTotals.totalFrais + currentTotals.achats;
    currentTotals.beneficeNet = currentTotals.gainEnterprise - currentTotals.totalDepenses;

    const byWeek = new Map();
    for (const r of allFrozen) {
      const k = r.year + '|' + r.week;
      if (!byWeek.has(k)) byWeek.set(k, { week: r.week, year: r.year, rows: [] });
      byWeek.get(k).rows.push(r);
    }
    const history = Array.from(byWeek.values()).map(w => {
      const totals = sumWeekStats(w.rows);
      totals.achats = purchasesByWeek.get(w.year + '|' + w.week) || 0;
      totals.totalDepenses = totals.totalPrimes + totals.totalFrais + totals.achats;
      totals.beneficeNet = totals.gainEnterprise - totals.totalDepenses;
      return {
        week: w.week, year: w.year,
        totals,
        rows: w.rows.map(r => ({
          employeeId: r.employeeId,
          name: r.employee
            ? r.employee.firstName + ' ' + r.employee.lastName
            : (r.employeeFirstName || r.employeeLastName)
              ? ((r.employeeFirstName || '') + ' ' + (r.employeeLastName || '')).trim()
              : '—',
          deliveries: r.deliveries,
          gainEnterprise: r.gainEnterprise,
          gainEmployee: r.gainEmployee,
          bonusSalary: r.bonusSalary,
          tierPrime: r.tierPrime,
          podiumPrize: r.podiumPrize,
          specialBonus: r.specialBonus,
          expenseRefund: r.expenseRefund,
          repatBonus: r.repatBonus,
          impoundReimbursement: r.impoundReimbursement,
          impoundPenalty: r.impoundPenalty,
          primeFinale: r.primeFinale,
          rank: r.rank,
        })).sort((a, b) => b.gainEnterprise - a.gainEnterprise),
      };
    });

    res.render('gouv/statistiques', {
      currentWeek, currentYear,
      currentTotals,
      currentTop: liveTop.map(r => ({
        employeeId: r.employee.id,
        name: r.employee.firstName + ' ' + r.employee.lastName,
        deliveries: r.deliveries,
        gainEnterprise: r.gainEnterprise,
        gainEmployee: r.gainEmployee,
        bonusSalary: r.bonusSalary,
        tierPrime: r.tierPrime,
        podiumPrize: r.podiumPrize,
        specialBonus: r.specialBonus,
        expenseRefund: r.expenseRefund,
        repatBonus: r.repatBonus,
        impoundReimbursement: r.impoundReimbursement,
        impoundPenalty: r.impoundPenalty,
        primeFinale: r.primeFinale,
        rank: r.rank,
      })),
      history,
    });
  } catch (err) {
    console.error('GET /gouv/statistiques error:', err);
    res.status(500).send('Erreur serveur');
  }
});

module.exports = router;
