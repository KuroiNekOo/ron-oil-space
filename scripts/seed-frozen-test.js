// One-off : seed une semaine figée avec 1 prime spéciale, 1 frais, 1 absence, 1 panne.
// Usage : node scripts/seed-frozen-test.js
const prisma = require('../src/db');
const { getWeekAndYear } = require('../src/services/week');

(async () => {
  const now = new Date();
  const { week: curW, year: curY } = getWeekAndYear(now);

  // Semaine précédente : on recule de 7 jours puis on relit l'ISO week-year
  // (gère proprement le passage d'année).
  const prevRef = new Date(now.getTime() - 7 * 86400000);
  const { week: prevWeek, year: prevYear } = getWeekAndYear(prevRef);

  const emp = await prisma.employee.findFirst({ where: { status: 'active' } });
  if (!emp) {
    console.error('Aucun employé actif trouvé');
    process.exit(1);
  }

  // 1) Marque la semaine comme figée (WeekStats minimal sur cet employé)
  const ws = await prisma.weekStats.upsert({
    where: {
      employeeId_week_year: { employeeId: emp.id, week: prevWeek, year: prevYear },
    },
    create: { employeeId: emp.id, week: prevWeek, year: prevYear },
    update: {},
  });

  // 2) Données bidon rattachées à cette semaine
  const absence = await prisma.absence.create({
    data: {
      employeeId: emp.id,
      week: prevWeek,
      year: prevYear,
      type: 'conge',
      dateStart: prevRef,
      dateEnd: prevRef,
      comment: '[TEST] frozen-week seed',
    },
  });

  const expense = await prisma.expense.create({
    data: {
      employeeId: emp.id,
      week: prevWeek,
      year: prevYear,
      type: 'carburant',
      amount: 42,
      comment: '[TEST] frozen-week seed',
    },
  });

  const breakdown = await prisma.breakdown.create({
    data: {
      employeeId: emp.id,
      week: prevWeek,
      year: prevYear,
      truckPlate: 'TEST-001',
      type: 'moteur',
      position: 'A1',
      comment: '[TEST] frozen-week seed',
    },
  });

  const bonus = await prisma.specialBonus.upsert({
    where: {
      employeeId_week_year: { employeeId: emp.id, week: prevWeek, year: prevYear },
    },
    create: {
      employeeId: emp.id,
      week: prevWeek,
      year: prevYear,
      amount: 100,
      reason: '[TEST] frozen-week seed',
    },
    update: { amount: 100, reason: '[TEST] frozen-week seed' },
  });

  console.log(JSON.stringify({
    currentWeek: curW, currentYear: curY,
    prevWeek, prevYear,
    employee: { id: emp.id, name: emp.firstName + ' ' + emp.lastName },
    weekStatsId: ws.id,
    absenceId: absence.id,
    expenseId: expense.id,
    breakdownId: breakdown.id,
    specialBonusId: bonus.id,
  }, null, 2));

  await prisma.$disconnect();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
