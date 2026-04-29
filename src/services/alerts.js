// Triggers planifiés côté web :
//  - rollover hebdo (dimanche PERIOD_START_HOUR:00) → notifie le bot
//  - check contrats expirants → notifie le bot (salon sécurité)
// Le bot n'a plus aucune logique métier ni aucun cron — il reçoit des payloads
// pré-construits et poste sur Discord.
const prisma = require('../db');
const { rolloverWeek } = require('./rollover');
const { notifyWeeklyStats, notifyContractAlert } = require('./bot');
const { refreshRecords } = require('./records');

const PERIOD_START_HOUR = parseInt(process.env.PERIOD_START_HOUR) || 18;
const CONTRACT_ALERT_HOURS = parseInt(process.env.CONTRACT_ALERT_HOURS) || 48;
// Fréquence de vérification des contrats (minutes). Défaut : 1440 = 1 check par jour.
const CONTRACT_CHECK_INTERVAL_MIN = parseInt(process.env.CONTRACT_CHECK_INTERVAL_MINUTES) || 1440;
// Fréquence de rafraîchissement des records (minutes). Défaut : 60 = 1 check / heure.
const RECORDS_REFRESH_INTERVAL_MIN = parseInt(process.env.RECORDS_REFRESH_INTERVAL_MINUTES) || 60;
const ALERT_LOG_KEY = 'contractAlertLog';
const WEEKLY_ROLLOVER_KEY = 'lastWeeklyRolloverKey';

async function getLastWeeklyKey() {
  const row = await prisma.config.findUnique({ where: { key: WEEKLY_ROLLOVER_KEY } });
  return row ? row.value : null;
}

async function setLastWeeklyKey(key) {
  await prisma.config.upsert({
    where: { key: WEEKLY_ROLLOVER_KEY },
    create: { key: WEEKLY_ROLLOVER_KEY, value: key },
    update: { value: key },
  });
}

function contractKey(alert) {
  return alert.name.toLowerCase() + '_' + alert.endDate;
}

// Map {key: ISO timestamp du dernier envoi} persistée en Config — survit aux reboots.
async function loadAlertLog() {
  const row = await prisma.config.findUnique({ where: { key: ALERT_LOG_KEY } });
  if (!row) return {};
  try { return JSON.parse(row.value) || {}; } catch { return {}; }
}

async function saveAlertLog(log) {
  const value = JSON.stringify(log);
  await prisma.config.upsert({
    where: { key: ALERT_LOG_KEY },
    create: { key: ALERT_LOG_KEY, value },
    update: { value },
  });
}

async function getExpiringContracts(hoursThreshold) {
  const now = new Date();
  const threshold = new Date(now.getTime() + hoursThreshold * 3600 * 1000);
  const employees = await prisma.employee.findMany({
    where: { status: 'active', endDate: { not: null } },
  });
  const expired = [];
  const expiring = [];
  for (const emp of employees) {
    if (!emp.endDate) continue;
    const end = new Date(emp.endDate);
    const payload = {
      id: emp.id,
      name: emp.firstName + ' ' + emp.lastName,
      discordId: emp.discordId,
      endDate: end.toISOString(),
    };
    if (end <= now) expired.push({ ...payload, status: 'expired' });
    else if (end <= threshold) expiring.push({ ...payload, status: 'expiring' });
  }
  return { expired, expiring };
}

function isBotUnreachable(err) {
  const m = String(err && err.message || err);
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(m);
}

async function runContractAlertCheck() {
  const { expired, expiring } = await getExpiringContracts(CONTRACT_ALERT_HOURS);
  const all = [...expired, ...expiring];
  if (all.length === 0) return { sent: 0 };

  const log = await loadAlertLog();

  // Purge des entrées orphelines : contrats dont la clé (name + endDate) a changé
  // (contrat renouvelé) ou qui ne sont plus dans la fenêtre d'alerte.
  const liveKeys = new Set(all.map(contractKey));
  let logDirty = false;
  for (const k of Object.keys(log)) {
    if (!liveKeys.has(k)) { delete log[k]; logDirty = true; }
  }

  // Un contrat (name + endDate) présent dans le log = déjà alerté = skip définitif.
  // Pour ré-alerter, il faut que la endDate change (renouvellement) → nouvelle clé.
  const fresh = all.filter(a => !log[contractKey(a)]);

  if (fresh.length === 0) {
    if (logDirty) await saveAlertLog(log); // purge quand même
    return { sent: 0 };
  }

  try {
    await notifyContractAlert({ alerts: fresh });
    const iso = new Date().toISOString();
    for (const a of fresh) log[contractKey(a)] = iso;
    await saveAlertLog(log);
    console.log('[alerts] contrats notifiés :', fresh.length);
    return { sent: fresh.length };
  } catch (err) {
    // Log non mis à jour → retry au prochain tick
    if (logDirty) await saveAlertLog(log);
    if (isBotUnreachable(err)) {
      console.warn('[alerts] bot injoignable, ' + fresh.length + ' alerte(s) contrat en attente');
    } else {
      console.error('[alerts] contract-alert failed:', err.message);
    }
    return { error: err.message, pending: fresh.length };
  }
}

async function runWeeklyRollover(opts) {
  // Fige la semaine qui vient de se terminer + envoie les embeds aux casiers.
  const result = await rolloverWeek(opts);
  if (result.employees && result.employees.length > 0) {
    try {
      await notifyWeeklyStats({
        week: result.week,
        year: result.year,
        period: result.period,
        employees: result.employees,
      });
      console.log('[alerts] rollover S' + result.week + ' ' + result.year + ' → ' + result.employees.length + ' casiers notifiés');
    } catch (err) {
      const tag = 'S' + result.week + ' ' + result.year;
      if (isBotUnreachable(err)) {
        console.warn('[alerts] bot injoignable — rollover ' + tag + ' figé en BDD mais embeds non envoyés');
      } else {
        console.error('[alerts] notifyWeeklyStats failed:', err.message);
      }
    }
  }
  return result;
}

// Vérifie chaque 30s si on est dans la minute pile de dimanche PERIOD_START_HOUR:00.
// La clé "YYYY-MM-DD" est persistée en BDD (Config.lastWeeklyRolloverKey) → reboot ou
// instances multiples, un seul trigger par dimanche quoi qu'il arrive.
async function tickWeekly() {
  const now = new Date();
  if (now.getDay() !== 0) return;
  if (now.getHours() !== PERIOD_START_HOUR) return;
  if (now.getMinutes() !== 0) return;
  const key = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
  const last = await getLastWeeklyKey();
  if (last === key) return;
  // Poser la clé AVANT d'exécuter → évite deux ticks concurrents qui passeraient le check
  await setLastWeeklyKey(key);
  runWeeklyRollover().catch(e => console.error('[alerts] weekly rollover failed:', e));
}

async function runRecordsRefresh() {
  try {
    const r = await refreshRecords();
    console.log(
      '[alerts] records rafraîchis : commun=' + r.companyRecord.value
      + ' livr. (S' + r.companyRecord.week + ' ' + r.companyRecord.year + '), '
      + 'indiv.=' + r.individualRecord.value + ' livr. ' + (r.individualRecord.name || '—')
      + ' (S' + r.individualRecord.week + ' ' + r.individualRecord.year + ')'
    );
  } catch (err) {
    console.error('[alerts] records refresh failed:', err.message);
  }
}

function startSchedulers() {
  // Weekly rollover : check chaque 30s (fenêtre 1min)
  setInterval(() => tickWeekly().catch(e => console.error('[alerts] tickWeekly:', e)), 30 * 1000);
  // Contract alerts : intervalle configurable (défaut 1 jour)
  setInterval(() => runContractAlertCheck(), CONTRACT_CHECK_INTERVAL_MIN * 60 * 1000);
  // Premier check contrats au démarrage
  setTimeout(() => runContractAlertCheck(), 5000);
  // Records : refresh au boot + intervalle configurable (défaut 60min).
  setTimeout(() => runRecordsRefresh(), 5000);
  setInterval(() => runRecordsRefresh(), RECORDS_REFRESH_INTERVAL_MIN * 60 * 1000);
  console.log('[alerts] schedulers démarrés (rollover dim. ' + PERIOD_START_HOUR + 'h00, contrats toutes les ' + CONTRACT_CHECK_INTERVAL_MIN + 'min, records toutes les ' + RECORDS_REFRESH_INTERVAL_MIN + 'min)');
}

module.exports = {
  startSchedulers,
  runWeeklyRollover,
  runContractAlertCheck,
  getExpiringContracts,
};
