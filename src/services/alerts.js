// Triggers planifiés côté web :
//  - rollover hebdo (dimanche PERIOD_START_HOUR:00) → notifie le bot
//  - check contrats expirants → notifie le bot (salon sécurité)
// Le bot n'a plus aucune logique métier ni aucun cron — il reçoit des payloads
// pré-construits et poste sur Discord.
const prisma = require('../db');
const { rolloverWeek } = require('./rollover');
const { notifyWeeklyStats, notifyContractAlert } = require('./bot');
const { refreshRecords } = require('./records');
const { runAbsenceDeactivationCheck } = require('./absences');

const PERIOD_START_HOUR = parseInt(process.env.PERIOD_START_HOUR) || 18;
const CONTRACT_ALERT_HOURS = parseInt(process.env.CONTRACT_ALERT_HOURS) || 48;
// Fréquence de vérification des contrats (minutes). Défaut : 1440 = 1 check par jour.
const CONTRACT_CHECK_INTERVAL_MIN = parseInt(process.env.CONTRACT_CHECK_INTERVAL_MINUTES) || 1440;
// Fréquence de rafraîchissement des records (minutes). Défaut : 60 = 1 check / heure.
const RECORDS_REFRESH_INTERVAL_MIN = parseInt(process.env.RECORDS_REFRESH_INTERVAL_MINUTES) || 60;
// Fréquence du check de désactivation auto sur absences (minutes). Défaut : 60min
// = un filet horaire. La désactivation immédiate au POST /absences couvre déjà
// les cas où l'absence débute aujourd'hui — ce tick rattrape uniquement les
// absences créées en avance (employé pas encore actif au moment du POST).
const ABSENCE_CHECK_INTERVAL_MIN = parseInt(process.env.ABSENCE_CHECK_INTERVAL_MINUTES) || 60;
const ALERT_LOG_KEY = 'contractAlertLog';
const WEEKLY_ROLLOVER_KEY = 'lastWeeklyRolloverKey';
// Payload des stats hebdo dont l'envoi au bot a échoué (bot injoignable) et
// qui reste à renvoyer. Persisté en Config → survit aux reboots du site.
const PENDING_WEEKLY_KEY = 'pendingWeeklyStats';

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

// ── Stats hebdo en attente de renvoi (bot injoignable au moment du rollover) ──
async function getPendingWeeklyStats() {
  const row = await prisma.config.findUnique({ where: { key: PENDING_WEEKLY_KEY } });
  if (!row || !row.value) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

async function setPendingWeeklyStats(payload) {
  const value = JSON.stringify(payload);
  await prisma.config.upsert({
    where: { key: PENDING_WEEKLY_KEY },
    create: { key: PENDING_WEEKLY_KEY, value },
    update: { value },
  });
}

async function clearPendingWeeklyStats() {
  await prisma.config.deleteMany({ where: { key: PENDING_WEEKLY_KEY } });
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
    const payload = {
      week: result.week,
      year: result.year,
      period: result.period,
      employees: result.employees,
    };
    try {
      await notifyWeeklyStats(payload);
      console.log('[alerts] rollover S' + result.week + ' ' + result.year + ' → ' + result.employees.length + ' casiers notifiés');
    } catch (err) {
      const tag = 'S' + result.week + ' ' + result.year;
      if (isBotUnreachable(err)) {
        // La semaine est figée en BDD ; seuls les embeds n'ont pas pu partir.
        // On met le payload en attente → retenvoyé automatiquement dès que le
        // bot revient (retryPendingWeeklyStats, tick 60s).
        await setPendingWeeklyStats(payload).catch(e => console.error('[alerts] setPendingWeeklyStats:', e.message));
        console.warn('[alerts] bot injoignable — rollover ' + tag + ' figé en BDD, embeds en attente de renvoi');
      } else {
        console.error('[alerts] notifyWeeklyStats failed:', err.message);
      }
    }
  }
  return result;
}

// Re-tente l'envoi des stats hebdo restées en attente (bot injoignable au
// rollover). Appelé périodiquement : dès que le bot revient, les embeds
// partent et le payload en attente est effacé. No-op s'il n'y a rien en attente.
async function retryPendingWeeklyStats() {
  const payload = await getPendingWeeklyStats();
  if (!payload) return;
  const tag = 'S' + payload.week + ' ' + payload.year;
  try {
    await notifyWeeklyStats(payload);
    await clearPendingWeeklyStats();
    console.log('[alerts] retry OK — stats ' + tag + ' enfin envoyées (' + (payload.employees?.length || 0) + ' casiers)');
  } catch (err) {
    if (isBotUnreachable(err)) {
      // Toujours injoignable → on garde le payload pour le prochain tick.
      console.warn('[alerts] retry stats ' + tag + ' : bot toujours injoignable, nouvel essai au prochain tick');
    } else {
      // Erreur non réseau (payload invalide ?) : on n'effacera pas en boucle
      // silencieusement, mais on logge clairement pour investigation.
      console.error('[alerts] retry stats ' + tag + ' échec non réseau:', err.message);
    }
  }
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
  // Retry des stats hebdo en attente (bot injoignable au rollover) : tick 60s
  // + un essai au boot (rattrape le cas où le site redémarre avec un payload en attente).
  setTimeout(() => retryPendingWeeklyStats().catch(e => console.error('[alerts] retry stats:', e)), 8000);
  setInterval(() => retryPendingWeeklyStats().catch(e => console.error('[alerts] retry stats:', e)), 60 * 1000);
  // Contract alerts : intervalle configurable (défaut 1 jour)
  setInterval(() => runContractAlertCheck(), CONTRACT_CHECK_INTERVAL_MIN * 60 * 1000);
  // Premier check contrats au démarrage
  setTimeout(() => runContractAlertCheck(), 5000);
  // Records : refresh au boot + intervalle configurable (défaut 60min).
  setTimeout(() => runRecordsRefresh(), 5000);
  setInterval(() => runRecordsRefresh(), RECORDS_REFRESH_INTERVAL_MIN * 60 * 1000);
  // Absences : check au boot + intervalle configurable (défaut 60min). Rattrape
  // les absences créées en avance qui doivent désactiver au passage de la date.
  setTimeout(() => runAbsenceDeactivationCheck().catch(e => console.error('[alerts] absences:', e)), 5000);
  setInterval(() => runAbsenceDeactivationCheck().catch(e => console.error('[alerts] absences:', e)), ABSENCE_CHECK_INTERVAL_MIN * 60 * 1000);
  console.log('[alerts] schedulers démarrés (rollover dim. ' + PERIOD_START_HOUR + 'h00, contrats toutes les ' + CONTRACT_CHECK_INTERVAL_MIN + 'min, records toutes les ' + RECORDS_REFRESH_INTERVAL_MIN + 'min, absences toutes les ' + ABSENCE_CHECK_INTERVAL_MIN + 'min)');
}

module.exports = {
  startSchedulers,
  runWeeklyRollover,
  retryPendingWeeklyStats,
  runContractAlertCheck,
  getExpiringContracts,
};
