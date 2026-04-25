// Script one-shot : remplit employeeFirstName/employeeLastName sur toutes les
// lignes existantes (WeekStats, Purchase, Absence, Expense, Breakdown,
// Repatriation, SpecialBonus) à partir de l'Employee actuellement lié.
// À exécuter UNE FOIS après `prisma db push` qui ajoute les colonnes snapshot.
// Idempotent : skip les rows déjà snapshot.
require('dotenv').config();
const prisma = require('../src/db');

const TABLES = [
  { name: 'weekStats',    label: 'WeekStats' },
  { name: 'purchase',     label: 'Purchase' },
  { name: 'absence',      label: 'Absence' },
  { name: 'expense',      label: 'Expense' },
  { name: 'breakdown',    label: 'Breakdown' },
  { name: 'repatriation', label: 'Repatriation' },
  { name: 'specialBonus', label: 'SpecialBonus' },
];

(async () => {
  let totalUpdated = 0;
  for (const t of TABLES) {
    const rows = await prisma[t.name].findMany({
      where: {
        employeeId: { not: null },
        OR: [{ employeeFirstName: null }, { employeeLastName: null }],
      },
      select: { id: true, employeeId: true },
    });
    if (rows.length === 0) {
      console.log(`[${t.label}] rien à backfill`);
      continue;
    }
    const empIds = [...new Set(rows.map(r => r.employeeId))];
    const employees = await prisma.employee.findMany({
      where: { id: { in: empIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    const empById = new Map(employees.map(e => [e.id, e]));
    let updated = 0;
    for (const r of rows) {
      const emp = empById.get(r.employeeId);
      if (!emp) continue;
      await prisma[t.name].update({
        where: { id: r.id },
        data: { employeeFirstName: emp.firstName, employeeLastName: emp.lastName },
      });
      updated++;
    }
    console.log(`[${t.label}] ${updated}/${rows.length} backfill`);
    totalUpdated += updated;
  }
  console.log(`\nTotal : ${totalUpdated} lignes mises à jour.`);
  await prisma.$disconnect();
})().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
