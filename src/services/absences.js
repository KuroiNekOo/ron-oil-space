// Helpers autour du modèle Absence : désactivation automatique des employés
// pendant leur absence, et flag de config global pour activer/désactiver ce
// comportement. La réactivation n'est jamais automatique (consigne produit).
const prisma = require('../db');
const { deactivateCasier } = require('./bot');

const AUTO_DEACTIVATE_KEY = 'autoDeactivateOnAbsence';
const DEFAULT_AUTO_DEACTIVATE = true;

async function isAutoDeactivateEnabled() {
  const row = await prisma.config.findUnique({ where: { key: AUTO_DEACTIVATE_KEY } });
  if (!row) return DEFAULT_AUTO_DEACTIVATE;
  return row.value === 'true';
}

async function setAutoDeactivateEnabled(value) {
  const v = value === true || value === 'true' || value === 'on' || value === '1';
  await prisma.config.upsert({
    where: { key: AUTO_DEACTIVATE_KEY },
    create: { key: AUTO_DEACTIVATE_KEY, value: v ? 'true' : 'false' },
    update: { value: v ? 'true' : 'false' },
  });
  return v;
}

function isBotUnreachable(err) {
  const m = String(err && err.message || err);
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(m);
}

// Désactive un employé (status='inactive') et notifie le bot pour rename salon
// + swap des rôles. Best-effort côté Discord : si le bot est down, la BDD est
// quand même mise à jour.
async function deactivateForAbsence(employeeId) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) return { skipped: 'not-found' };
  if (employee.status !== 'active') return { skipped: 'already-inactive' };

  await prisma.employee.update({
    where: { id: employeeId },
    data: { status: 'inactive' },
  });

  const channelId = employee.channelId || employee.casierId || null;
  let botWarning = null;
  if (channelId || employee.discordId) {
    try {
      await deactivateCasier({
        channelId,
        discordId: employee.discordId,
        firstName: employee.firstName,
        lastName: employee.lastName,
      });
    } catch (err) {
      if (isBotUnreachable(err)) {
        console.warn('[absences] bot injoignable, désactivation Discord ' + employee.id + ' en attente');
      } else {
        console.error('[absences] deactivateCasier failed:', err.message);
      }
      botWarning = err.message;
    }
  }
  console.log('[absences] employé ' + employee.id + ' (' + employee.firstName + ' ' + employee.lastName + ') désactivé (absence)');
  return { ok: true, botWarning };
}

// Tick journalier : pour chaque employé actif ayant une absence en cours
// (dateStart <= now <= dateEnd), désactive. La règle "si déjà inactif → no-op"
// est portée par deactivateForAbsence, donc on peut faire passer plusieurs
// fois sans souci.
async function runAbsenceDeactivationCheck() {
  if (!(await isAutoDeactivateEnabled())) return { skipped: 'disabled', deactivated: 0 };
  const now = new Date();
  const absences = await prisma.absence.findMany({
    where: {
      employeeId: { not: null },
      dateStart: { lte: now },
      dateEnd: { gte: now },
    },
    select: { employeeId: true },
  });
  // Dedup : un employé avec 2 absences chevauchantes ne doit être traité qu'une fois.
  const ids = Array.from(new Set(absences.map(a => a.employeeId)));
  if (ids.length === 0) return { deactivated: 0 };
  const active = await prisma.employee.findMany({
    where: { id: { in: ids }, status: 'active' },
    select: { id: true },
  });
  let deactivated = 0;
  for (const e of active) {
    try {
      const r = await deactivateForAbsence(e.id);
      if (r && r.ok) deactivated++;
    } catch (err) {
      console.error('[absences] check tick deactivate id=' + e.id + ':', err.message);
    }
  }
  if (deactivated > 0) console.log('[absences] tick : ' + deactivated + ' employé(s) désactivé(s)');
  return { deactivated };
}

module.exports = {
  isAutoDeactivateEnabled,
  setAutoDeactivateEnabled,
  deactivateForAbsence,
  runAbsenceDeactivationCheck,
};
