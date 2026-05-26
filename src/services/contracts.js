// Génération + signatures de contrats.
//
// Workflow :
//  1. generateForEmployee(employeeId, opts)  → crée Contract pending + signToken
//  2. signByEmployee(token, name, ip, ua)    → status = employee-signed
//      └─ Si autoCompanySignature flag ON, passe direct en company-signed.
//  3. signByCompany(contractId, byName)       → status = company-signed (manuel)
//  4. signByLawyer(token, password, ...)      → status = signed (final)
//  5. supersedeAndRenew(employeeId, newDates) → ancien=superseded + nouveau pending
//
// htmlSnapshot est figé à la génération : l'historique survit aux modifs futures
// du template. La logique de rendu accepte un objet de variables et substitue
// les {{placeholders}} dans le HTML — pas d'évaluation d'expression, pas de XSS
// par template (le HTML provient déjà de l'admin de confiance via Quill).
const crypto = require('crypto');
const prisma = require('../db');

// ── Config Flags (toggle entreprise auto + seuils renouvellement) ──────────

const AUTO_COMPANY_SIGN_KEY = 'autoCompanySignature';
const RENEW_GREEN_KEY  = 'contractRenewGreenDays';
const RENEW_ORANGE_KEY = 'contractRenewOrangeDays';
const RENEW_RED_KEY    = 'contractRenewRedDays';
const DEFAULT_AUTO_COMPANY_SIGN = false;
const DEFAULT_GREEN_DAYS = 30;
const DEFAULT_ORANGE_DAYS = 14;
const DEFAULT_RED_DAYS = 3;

async function getConfigString(key, fallback) {
  const row = await prisma.config.findUnique({ where: { key } });
  return row ? row.value : fallback;
}
async function setConfigString(key, value) {
  await prisma.config.upsert({
    where: { key },
    create: { key, value: String(value) },
    update: { value: String(value) },
  });
}

async function isAutoCompanySignatureEnabled() {
  const v = await getConfigString(AUTO_COMPANY_SIGN_KEY, null);
  if (v == null) return DEFAULT_AUTO_COMPANY_SIGN;
  return v === 'true';
}
async function setAutoCompanySignatureEnabled(value) {
  const v = value === true || value === 'true' || value === 'on' || value === '1';
  await setConfigString(AUTO_COMPANY_SIGN_KEY, v ? 'true' : 'false');
  return v;
}

async function getRenewThresholds() {
  const [g, o, r] = await Promise.all([
    getConfigString(RENEW_GREEN_KEY, null),
    getConfigString(RENEW_ORANGE_KEY, null),
    getConfigString(RENEW_RED_KEY, null),
  ]);
  const greenDays  = parseInt(g)  || DEFAULT_GREEN_DAYS;
  const orangeDays = parseInt(o)  || DEFAULT_ORANGE_DAYS;
  const redDays    = parseInt(r)  || DEFAULT_RED_DAYS;
  return { greenDays, orangeDays, redDays };
}

async function setRenewThresholds({ greenDays, orangeDays, redDays }) {
  // Garde-fou : red < orange < green, tous > 0
  const g = parseInt(greenDays);
  const o = parseInt(orangeDays);
  const r = parseInt(redDays);
  if (!isFinite(g) || !isFinite(o) || !isFinite(r) || g <= 0 || o <= 0 || r <= 0) {
    throw new Error('Seuils invalides : doivent tous être > 0');
  }
  if (!(r < o && o < g)) {
    throw new Error('Les seuils doivent respecter : rouge < orange < vert');
  }
  await Promise.all([
    setConfigString(RENEW_GREEN_KEY, g),
    setConfigString(RENEW_ORANGE_KEY, o),
    setConfigString(RENEW_RED_KEY, r),
  ]);
  return { greenDays: g, orangeDays: o, redDays: r };
}

// ── Urgence d'un contrat selon endDate vs now ──────────────────────────────

// 'none'  → pas de endDate ou très loin (au-delà du seuil vert) ou contrat sans suite (CDI)
// 'green' → entre orangeDays et greenDays
// 'orange'→ entre redDays et orangeDays
// 'red'   → ≤ redDays, ou déjà expiré
function contractUrgencyFromDate(endDate, thresholds, now = new Date()) {
  if (!endDate) return 'none';
  const end = new Date(endDate);
  if (!isFinite(end.getTime())) return 'none';
  const diffMs = end.getTime() - now.getTime();
  const diffDays = diffMs / 86400000;
  const { greenDays, orangeDays, redDays } = thresholds;
  if (diffDays <= redDays) return 'red';        // inclus les expirés (diffDays négatif)
  if (diffDays <= orangeDays) return 'orange';
  if (diffDays <= greenDays) return 'green';
  return 'none';
}

// ── Templates ──────────────────────────────────────────────────────────────

// Normalise un kind reçu de l'extérieur. 'CDI'/'CDD' acceptés, sinon null.
function normalizeKind(k) {
  if (typeof k !== 'string') return null;
  const v = k.trim().toUpperCase();
  if (v === 'CDI' || v === 'CDD') return v;
  return null;
}

// Récupère le template actif pour un type donné. Fallback : si pas de template
// spécifique au kind, retombe sur un template actif générique (kind=null) —
// permet à un admin de n'avoir qu'un seul template "tous types" s'il préfère.
async function getActiveTemplate(kind) {
  const k = normalizeKind(kind);
  if (k) {
    const specific = await prisma.contractTemplate.findFirst({
      where: { isActive: true, kind: k },
      orderBy: { updatedAt: 'desc' },
    });
    if (specific) return specific;
  }
  return prisma.contractTemplate.findFirst({
    where: { isActive: true, kind: null },
    orderBy: { updatedAt: 'desc' },
  });
}

async function listTemplates() {
  return prisma.contractTemplate.findMany({
    orderBy: [{ kind: 'asc' }, { updatedAt: 'desc' }],
  });
}

// Liste tous les templates actifs, indexés par kind. Utilisé par la page
// /admin/contracts pour afficher d'un coup d'œil ce qui est en vigueur.
async function getActiveTemplatesByKind() {
  const actives = await prisma.contractTemplate.findMany({ where: { isActive: true } });
  return {
    CDI: actives.find(t => t.kind === 'CDI') || null,
    CDD: actives.find(t => t.kind === 'CDD') || null,
    generic: actives.find(t => t.kind === null) || null,
  };
}

async function saveTemplate({ id, name, content, kind, setActive }) {
  const normalizedKind = normalizeKind(kind);
  if (id) {
    const updated = await prisma.contractTemplate.update({
      where: { id: parseInt(id) },
      data: { name, content, kind: normalizedKind },
    });
    if (setActive) await activateTemplate(updated.id);
    return updated;
  }
  const created = await prisma.contractTemplate.create({
    data: { name, content, kind: normalizedKind, isActive: false },
  });
  if (setActive) await activateTemplate(created.id);
  return created;
}

// Activation d'un template : ne désactive QUE les autres templates du même
// kind. Si on active un CDI, on peut garder un CDD actif en parallèle.
// Un template générique (kind=null) cohabite avec les spécialisés sans conflit.
async function activateTemplate(id) {
  const targetId = parseInt(id);
  const target = await prisma.contractTemplate.findUnique({ where: { id: targetId } });
  if (!target) throw new Error('Template introuvable');
  await prisma.$transaction([
    prisma.contractTemplate.updateMany({
      where: { isActive: true, kind: target.kind, id: { not: targetId } },
      data: { isActive: false },
    }),
    prisma.contractTemplate.update({ where: { id: targetId }, data: { isActive: true } }),
  ]);
}

// Substitution naïve des {{placeholders}}. On échappe les valeurs HTML pour
// éviter qu'une donnée employée (commentaire, etc.) ne casse le rendu. Le
// HTML du template lui-même n'est pas échappé (provient de l'admin via Quill).
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDateFr(d) {
  if (!d) return '';
  const date = new Date(d);
  if (!isFinite(date.getTime())) return '';
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function renderTemplate(html, vars) {
  if (!html) return '';
  return html.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? '' : escapeHtml(v);
  });
}

// ── Génération + signatures ────────────────────────────────────────────────

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Récupère la chaîne d'options pour rendre le HTML : on lit les valeurs Config
// utiles aux placeholders entreprise (companyName, directorName).
async function getCompanyVars() {
  return {
    companyName: await getConfigString('companyName', 'Ron Oil'),
    directorName: await getConfigString('directorName', 'La Direction'),
  };
}

async function buildVarsForEmployee(employee, dates) {
  const company = await getCompanyVars();
  // Si l'employé remplace quelqu'un, on expose `replaces` pour le template.
  let replaces = '';
  if (employee.replacesFirstName || employee.replacesLastName) {
    replaces = (employee.replacesFirstName + ' ' + employee.replacesLastName).trim();
  }
  return {
    firstName: employee.firstName,
    lastName: employee.lastName,
    role: employee.role,
    contract: employee.contract,
    phone: employee.phone || '',
    iban: employee.iban || '',
    startDate: fmtDateFr(dates.startDate),
    endDate: fmtDateFr(dates.endDate),
    today: fmtDateFr(new Date()),
    replaces,
    ...company,
  };
}

// Crée un Contract pending pour un employé. Sert à la fois pour la première
// génération (création de l'employé) et pour les renouvellements.
// opts.startDate / opts.endDate sont en Date ou ISO string.
async function generateForEmployee(employeeId, opts = {}) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new Error('Employé introuvable');
  const template = await getActiveTemplate(employee.contract);
  if (!template) {
    throw new Error(
      'Aucun template actif pour les contrats ' + employee.contract +
      ' (ni de template générique). Configure-en un dans /admin/contracts.'
    );
  }

  const startDate = opts.startDate ? new Date(opts.startDate) : employee.hireDate || new Date();
  const endDate = opts.endDate ? new Date(opts.endDate) : employee.endDate;

  const vars = await buildVarsForEmployee(employee, { startDate, endDate });
  const htmlSnapshot = renderTemplate(template.content, vars);

  const contract = await prisma.contract.create({
    data: {
      employeeId: employee.id,
      employeeFirstName: employee.firstName,
      employeeLastName: employee.lastName,
      templateId: template.id,
      htmlSnapshot,
      contractKind: employee.contract,
      startDate,
      endDate,
      status: 'pending',
      signToken: newToken(),
      // Le lawyerSignToken est généré aussi à la création — l'admin pourra le
      // copier dès qu'il veut, même si la signature n'aboutira que quand l'état
      // sera company-signed.
      lawyerSignToken: newToken(),
    },
  });
  return contract;
}

async function signByEmployee(token, { name, ip, userAgent }) {
  const contract = await prisma.contract.findUnique({ where: { signToken: token } });
  if (!contract) throw new Error('Contrat introuvable');
  if (contract.status !== 'pending') throw new Error('Ce contrat n\'est plus en attente de signature');
  if (!name || !String(name).trim()) throw new Error('Le nom est requis');

  const autoCompany = await isAutoCompanySignatureEnabled();
  const data = {
    signedAt: new Date(),
    signedName: String(name).trim(),
    signedIp: ip || null,
    signedUserAgent: userAgent || null,
    status: 'employee-signed',
  };
  // Application du toggle uniquement aux contrats futurs : décidée AU MOMENT
  // de la signature employé, pas rétroactivement (le toggle au moment où l'admin
  // l'active n'impacte donc pas les contrats déjà employee-signed).
  if (autoCompany) {
    data.status = 'company-signed';
    data.companySignedAt = new Date();
    data.companySignedBy = 'auto';
    data.companySignedAuto = true;
  }
  return prisma.contract.update({ where: { id: contract.id }, data });
}

async function signByCompany(contractId, { byName }) {
  const contract = await prisma.contract.findUnique({ where: { id: contractId } });
  if (!contract) throw new Error('Contrat introuvable');
  if (contract.status !== 'employee-signed') {
    throw new Error('Le contrat doit être signé par l\'employé d\'abord');
  }
  return prisma.contract.update({
    where: { id: contractId },
    data: {
      status: 'company-signed',
      companySignedAt: new Date(),
      companySignedBy: byName || 'Admin',
      companySignedAuto: false,
    },
  });
}

async function signByLawyer(token, { password, name, ip }) {
  const contract = await prisma.contract.findUnique({ where: { lawyerSignToken: token } });
  if (!contract) throw new Error('Lien invalide');
  if (contract.status !== 'company-signed') {
    throw new Error('Le contrat n\'est pas encore prêt pour la signature avocat');
  }
  if (!name || !String(name).trim()) throw new Error('Le nom est requis');

  const account = await prisma.lawyerAccount.findFirst();
  if (!account || !password || account.password !== password) {
    throw new Error('Mot de passe avocat incorrect');
  }
  return prisma.contract.update({
    where: { id: contract.id },
    data: {
      status: 'signed',
      lawyerSignedAt: new Date(),
      lawyerSignedName: String(name).trim(),
      lawyerSignedIp: ip || null,
    },
  });
}

async function cancelContract(contractId) {
  return prisma.contract.update({
    where: { id: contractId },
    data: { status: 'cancelled' },
  });
}

// Renouvellement : marque l'ancien contrat comme superseded, met à jour la
// endDate de l'employé pour qu'elle reflète la nouvelle valeur (le scheduler
// d'alerte fin de contrat se base sur Employee.endDate), puis crée un nouveau
// Contract pending pour redémarrer le cycle de signature.
async function supersedeAndRenew(employeeId, { startDate, endDate }) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new Error('Employé introuvable');
  if (!startDate || !endDate) throw new Error('startDate et endDate requis');

  const sStart = new Date(startDate);
  const sEnd = new Date(endDate);
  if (sEnd <= sStart) throw new Error('endDate doit être après startDate');

  // Tous les contrats vivants (pending → company-signed → signed) passent en
  // superseded sauf cancelled/superseded déjà. Le contrat 'signed' qui devient
  // 'superseded' garde son htmlSnapshot et son historique de signatures.
  const active = await prisma.contract.findMany({
    where: {
      employeeId,
      status: { in: ['pending', 'employee-signed', 'company-signed', 'signed'] },
    },
    select: { id: true },
  });
  if (active.length > 0) {
    await prisma.contract.updateMany({
      where: { id: { in: active.map(c => c.id) } },
      data: { status: 'superseded' },
    });
  }

  // Aligne l'Employee.endDate avec le nouveau contrat — sert au scheduler de
  // fin de contrat (services/alerts.js) et à l'affichage liste salariés.
  await prisma.employee.update({
    where: { id: employeeId },
    data: { endDate: sEnd },
  });

  return generateForEmployee(employeeId, { startDate: sStart, endDate: sEnd });
}

// ── LawyerAccount ──────────────────────────────────────────────────────────

async function getLawyerAccount() {
  return prisma.lawyerAccount.findFirst();
}

async function setLawyerPassword(password) {
  if (!password || !String(password).trim()) throw new Error('Mot de passe requis');
  const existing = await prisma.lawyerAccount.findFirst();
  if (existing) {
    return prisma.lawyerAccount.update({
      where: { id: existing.id },
      data: { password: String(password).trim() },
    });
  }
  return prisma.lawyerAccount.create({ data: { password: String(password).trim() } });
}

module.exports = {
  // Config
  isAutoCompanySignatureEnabled, setAutoCompanySignatureEnabled,
  getRenewThresholds, setRenewThresholds,
  contractUrgencyFromDate,
  // Templates
  getActiveTemplate, getActiveTemplatesByKind,
  listTemplates, saveTemplate, activateTemplate,
  renderTemplate, buildVarsForEmployee,
  // Contrats
  generateForEmployee,
  signByEmployee, signByCompany, signByLawyer,
  cancelContract, supersedeAndRenew,
  // Lawyer account
  getLawyerAccount, setLawyerPassword,
};
