// API publique minimale :
//  - Apps Script → /logs/import + /logs/last-row (shared secret)
//  - Monitoring / outils manuels → /health + /week + /week/rollover
// Toutes les anciennes routes "bot" (stats, employees, contracts, config) ont été
// supprimées : le bot n'est plus qu'un relais Discord piloté par le web.
const express = require('express');
const router = express.Router();
const prisma = require('../db');
const { getWeekFromTimestamp, getWeekAndYear } = require('../services/week');
const { rolloverWeek } = require('../services/rollover');
const { refreshRecords } = require('../services/records');

const LOGS_API_SECRET = process.env.LOGS_API_SECRET || '';

function requireLogsSecret(req, res, next) {
  if (!LOGS_API_SECRET || req.headers['x-api-secret'] !== LOGS_API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

router.get('/week', (req, res) => {
  res.json(getWeekAndYear(new Date()));
});

// Re-trigger manuel du rollover d'une semaine donnée (sans diffusion Discord).
// La diffusion auto du dimanche 18h passe par services/alerts.js.
router.post('/week/rollover', requireLogsSecret, async (req, res) => {
  try {
    const { week, year } = req.body || {};
    const opts = {};
    if (week) opts.week = parseInt(week);
    if (year) opts.year = parseInt(year);
    const result = await rolloverWeek(Object.keys(opts).length ? opts : undefined);
    res.json(result);
  } catch (err) {
    console.error('Rollover error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/last-row → { lastRow: <max(sheetRow)> } ou 0 si la table est vide.
router.get('/logs/last-row', requireLogsSecret, async (req, res) => {
  try {
    const max = await prisma.logEntry.aggregate({ _max: { sheetRow: true } });
    res.json({ lastRow: max._max.sheetRow || 0 });
  } catch (err) {
    console.error('GET /api/logs/last-row error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/logs/import
// Payload : { entries: [{ sheetRow, timestamp, type, rawData }] }
// Upsert par `sheetRow` → idempotent. Renvoie { inserted, updated, skipped }.
router.post('/logs/import', requireLogsSecret, async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];

    const valid = [];
    let skipped = 0;
    for (const entry of entries) {
      const sheetRow = parseInt(entry?.sheetRow);
      if (!sheetRow || !entry.timestamp || !entry.type || entry.rawData == null) {
        skipped++;
        continue;
      }
      const timestamp = new Date(entry.timestamp);
      if (isNaN(timestamp.getTime())) {
        skipped++;
        continue;
      }
      const raw = String(entry.rawData);
      const { week, year } = getWeekAndYear(timestamp);
      valid.push({
        sheetRow,
        type: String(entry.type),
        timestamp,
        week,
        year,
        data: JSON.stringify(raw.split('::')),
        rawData: raw,
      });
    }

    const sheetRows = valid.map(v => v.sheetRow);
    const existingRows = sheetRows.length
      ? await prisma.logEntry.findMany({
          where: { sheetRow: { in: sheetRows } },
          select: { sheetRow: true },
        })
      : [];
    const existingSet = new Set(existingRows.map(r => r.sheetRow));

    let inserted = 0;
    let updated = 0;
    for (const data of valid) {
      await prisma.logEntry.upsert({
        where: { sheetRow: data.sheetRow },
        create: data,
        update: data,
      });
      if (existingSet.has(data.sheetRow)) updated++;
      else inserted++;
    }

    // Si au moins 1 ligne delivery a bougé, on réévalue les records
    // immédiatement (évite l'attente du tick périodique).
    const deliveryTouched = valid.some(v => v.type === 'delivery');
    if (deliveryTouched) {
      refreshRecords().catch(e => console.error('[api] refreshRecords après import:', e.message));
    }

    res.json({ inserted, updated, skipped });
  } catch (err) {
    console.error('POST /api/logs/import error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
