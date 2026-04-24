// Inspection du timestamp d'un log récent pour diagnostiquer le décalage TZ.
// Usage : node scripts/check-log-tz.js
const prisma = require('../src/db');

(async () => {
  const log = await prisma.logEntry.findFirst({
    orderBy: { timestamp: 'desc' },
  });
  if (!log) {
    console.log('Aucun log en DB');
    process.exit(0);
  }
  const d = log.timestamp;
  console.log({
    id: log.id,
    type: log.type,
    sheetRow: log.sheetRow,
    stored_iso_utc: d.toISOString(),
    as_paris: d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
    as_utc:   d.toLocaleString('fr-FR', { timeZone: 'UTC' }),
    rawData_preview: String(log.rawData).slice(0, 120),
  });
  await prisma.$disconnect();
})();
