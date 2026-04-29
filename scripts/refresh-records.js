// Recalcule les records (commun + individuel) à partir de tous les LogEntry
// type=delivery et écrit le résultat dans Config.records.
// Run : `node scripts/refresh-records.js`
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Paris';

const { refreshRecords } = require('../src/services/records');
const prisma = require('../src/db');

(async () => {
  try {
    const r = await refreshRecords();
    console.log('Records mis à jour :');
    console.log('  commun     :', r.companyRecord.value, 'livr.',
      '(S' + r.companyRecord.week + ' ' + r.companyRecord.year + ')');
    console.log('  individuel :', r.individualRecord.value, 'livr.',
      '— ' + (r.individualRecord.name || '—'),
      '(S' + r.individualRecord.week + ' ' + r.individualRecord.year + ')');
    console.log('  computedAt :', r.computedAt);
  } catch (err) {
    console.error('Erreur :', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
