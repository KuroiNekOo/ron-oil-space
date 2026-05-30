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

// ── Bourse publique ──
// GET /api/bourse?range=24H → données agrégées de livraisons par station, sur la
// fenêtre temporelle demandée. Buckets pré-calculés côté serveur pour éviter
// d'envoyer 30k events à un client public. Le payload reste léger même sur 30J.
const BOURSE_RANGES = {
  '1H':  { ms: 60 * 60 * 1000,           bucketMs: 60 * 1000,           points: 60  },
  '6H':  { ms: 6 * 60 * 60 * 1000,       bucketMs: 5 * 60 * 1000,       points: 72  },
  '24H': { ms: 24 * 60 * 60 * 1000,      bucketMs: 10 * 60 * 1000,      points: 144 },
  '7D':  { ms: 7 * 24 * 60 * 60 * 1000,  bucketMs: 60 * 60 * 1000,      points: 168 },
  '30D': { ms: 30 * 24 * 60 * 60 * 1000, bucketMs: 6 * 60 * 60 * 1000,  points: 120 },
  '60D': { ms: 60 * 24 * 60 * 60 * 1000, bucketMs: 12 * 60 * 60 * 1000, points: 120 },
};

router.get('/bourse', async (req, res) => {
  try {
    const rangeKey = BOURSE_RANGES[req.query.range] ? req.query.range : '24H';
    const cfg = BOURSE_RANGES[rangeKey];

    const now = Date.now();
    // Aligner la fin du dernier bucket sur le bucket courant (inclusif).
    const endMs = Math.floor(now / cfg.bucketMs) * cfg.bucketMs + cfg.bucketMs;
    const startMs = endMs - cfg.points * cfg.bucketMs;

    const logs = await prisma.logEntry.findMany({
      where: { type: 'delivery', timestamp: { gte: new Date(startMs), lt: new Date(endMs) } },
      select: { timestamp: true, data: true },
      orderBy: { timestamp: 'asc' },
    });

    // Pour les "latest price" et "last delivery", on a besoin de la donnée la plus
    // récente toutes stations confondues — pas forcément dans la fenêtre.
    const latestPerStation = new Map();
    const stationsAcc = new Map(); // key → { counts:[points], lastPrice, lastTs, totalDeliveries }

    function ensureStation(key) {
      if (!stationsAcc.has(key)) {
        stationsAcc.set(key, {
          counts: new Array(cfg.points).fill(0),
          deliveriesInRange: 0,
        });
      }
      return stationsAcc.get(key);
    }

    for (const l of logs) {
      let d;
      try { d = JSON.parse(l.data); } catch { continue; }
      const station = d[1];
      if (!station) continue;
      const ts = l.timestamp.getTime();
      const idx = Math.floor((ts - startMs) / cfg.bucketMs);
      if (idx < 0 || idx >= cfg.points) continue;
      const acc = ensureStation(station);
      acc.counts[idx] += 1;
      acc.deliveriesInRange += 1;
      const priceRaw = d[5];
      const price = priceRaw != null && priceRaw !== '' && !isNaN(parseFloat(priceRaw))
        ? parseFloat(priceRaw) : null;
      latestPerStation.set(station, { ts, price });
    }

    // Pour les stations qui n'ont aucune livraison dans la fenêtre, on récupère
    // la dernière livraison historique parmi les ~2000 derniers logs (suffisant
    // pour couvrir 31 stations) afin d'avoir "dernier prix connu" même si la
    // station est silencieuse sur la période.
    const recentForFallback = await prisma.logEntry.findMany({
      where: { type: 'delivery' },
      select: { timestamp: true, data: true },
      orderBy: { timestamp: 'desc' },
      take: 2000,
    });
    for (const l of recentForFallback) {
      let d;
      try { d = JSON.parse(l.data); } catch { continue; }
      const station = d[1];
      if (!station) continue;
      if (latestPerStation.has(station)) continue;
      const priceRaw = d[5];
      const price = priceRaw != null && priceRaw !== '' && !isNaN(parseFloat(priceRaw))
        ? parseFloat(priceRaw) : null;
      latestPerStation.set(station, { ts: l.timestamp.getTime(), price });
    }

    // S'assurer que toutes les stations rencontrées (même hors fenêtre) soient présentes
    for (const key of latestPerStation.keys()) ensureStation(key);

    const stations = [...stationsAcc.entries()].map(([key, v]) => {
      const last = latestPerStation.get(key);
      return {
        key,
        counts: v.counts,
        deliveries: v.deliveriesInRange,
        lastPrice: last?.price ?? null,
        lastDeliveryTs: last?.ts ?? null,
      };
    });

    res.json({
      range: rangeKey,
      bucketMs: cfg.bucketMs,
      startMs,
      endMs,
      points: cfg.points,
      stations,
    });
  } catch (err) {
    console.error('GET /api/bourse error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
