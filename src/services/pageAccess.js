// Contrôle d'accès aux pages admin par rôle.
//
// - Registre canonique des pages admin (key + label + préfixes de route).
// - Restrictions persistées en Config['pageRestrictions'] (JSON) :
//     { "<roleName>": ["<pageKey>", ...] }  → pages INTERDITES pour ce rôle.
//   Défaut = map vide → aucune restriction (comportement historique).
// - Les rôles « Direction » (cf. services/roles.js) et l'admin primaire ont
//   toujours accès à tout et sont seuls à pouvoir gérer roles + restrictions.
// - Les pages `directionOnly` (roles, permissions) ne sont jamais ouvrables à un
//   non-direction : anti-escalade de privilèges.
//
// Cache module-level invalidé par setRestrictions(), même pattern que roles.js.
const prisma = require('../db');

const KEY = 'pageRestrictions';

// L'ordre définit aussi l'ordre de repli de firstAllowedPath().
// `path` = URL admin réelle de la page (pour la landing / redirection).
// `prefixes` = préfixes de req.path (sans /admin) couverts par la page.
const PAGES = [
  { key: 'salaries',      label: 'Salariés',      path: '/admin/salaries',      prefixes: ['/salaries'] },
  { key: 'vehicules',     label: 'Véhicules',     path: '/admin/vehicules',     prefixes: ['/vehicules'] },
  { key: 'achats',        label: 'Achats',        path: '/admin/achats',        prefixes: ['/achats'] },
  { key: 'primes',        label: 'Primes',        path: '/admin/primes',        prefixes: ['/primes', '/reimbursements', '/tier-config', '/special-bonus'] },
  { key: 'roles',         label: 'Rôles',         path: '/admin/roles',         prefixes: ['/roles'],         directionOnly: true },
  { key: 'permissions',   label: 'Accès',         path: '/admin/permissions',   prefixes: ['/permissions'],   directionOnly: true },
  { key: 'types',         label: 'Types',         path: '/admin/types',         prefixes: ['/types'] },
  { key: 'contracts',     label: 'Contrats',      path: '/admin/contracts',     prefixes: ['/contracts'] },
  { key: 'faq',           label: 'FAQ',           path: '/admin/faq',           prefixes: ['/faq'] },
  { key: 'gouv',          label: 'Gouvernement',  path: '/admin/gouv',          prefixes: ['/gouv'] },
  { key: 'absences',      label: 'Absences',      path: '/admin/absences',      prefixes: ['/absences'] },
  { key: 'frais',         label: 'Frais',         path: '/admin/frais',         prefixes: ['/frais'] },
  { key: 'pannes',        label: 'Pannes',        path: '/admin/pannes',        prefixes: ['/pannes'] },
  { key: 'rapatriements', label: 'Rapatriements', path: '/admin/rapatriements', prefixes: ['/rapatriements'] },
  { key: 'statistiques',  label: 'Statistiques',  path: '/admin/statistiques',  prefixes: ['/statistiques'] },
  { key: 'tracabilite',   label: 'Traçabilité',   path: '/admin/standard',      prefixes: ['/standard', '/livraisons', '/facturations', '/entrees-sorties', '/services'] },
];

const PAGE_KEYS = new Set(PAGES.map(p => p.key));

// Pages réellement restreignables dans la matrice (hors direction-only).
const RESTRICTABLE_PAGES = PAGES.filter(p => !p.directionOnly);

let _cache = null;

// Mappe un req.path (ex: '/salaries/12/edit') vers une page key, ou null si la
// route n'appartient à aucune page du registre (laissée passer telle quelle).
function pageKeyForPath(path) {
  const p = String(path || '');
  for (const page of PAGES) {
    for (const prefix of page.prefixes) {
      if (p === prefix || p.startsWith(prefix + '/')) return page.key;
    }
  }
  return null;
}

function sanitize(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [role, keys] of Object.entries(input)) {
    const name = String(role || '').trim();
    if (!name || !Array.isArray(keys)) continue;
    // On ne stocke que des keys valides et restreignables (jamais direction-only).
    const denied = [...new Set(
      keys.map(k => String(k || '').trim())
          .filter(k => PAGE_KEYS.has(k) && !PAGES.find(p => p.key === k).directionOnly)
    )];
    if (denied.length) out[name] = denied;
  }
  return out;
}

async function getRestrictions() {
  if (_cache) return _cache;
  const row = await prisma.config.findUnique({ where: { key: KEY } });
  let map = {};
  if (row) {
    try {
      map = sanitize(JSON.parse(row.value));
    } catch {
      map = {};
    }
  }
  _cache = map;
  return _cache;
}

async function setRestrictions(input) {
  const clean = sanitize(input);
  await prisma.config.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(clean) },
    update: { value: JSON.stringify(clean) },
  });
  _cache = clean;
  return clean;
}

// ctx = { roleName, isDirection } — résolu côté middleware.
function isPageAllowed(pageKey, ctx, restrictions) {
  if (!PAGE_KEYS.has(pageKey)) return true; // page hors registre → non gérée ici
  if (ctx && ctx.isDirection) return true;
  const page = PAGES.find(p => p.key === pageKey);
  if (page.directionOnly) return false;
  const denied = (restrictions && ctx && restrictions[ctx.roleName]) || [];
  return !denied.includes(pageKey);
}

// Set des keys autorisées pour le contexte courant (consommé par la sidebar).
function allowedPageKeys(ctx, restrictions) {
  const set = new Set();
  for (const page of PAGES) {
    if (isPageAllowed(page.key, ctx, restrictions)) set.add(page.key);
  }
  return set;
}

// Première page autorisée (landing / redirection quand la cible est bloquée).
function firstAllowedPath(ctx, restrictions) {
  for (const page of PAGES) {
    if (isPageAllowed(page.key, ctx, restrictions)) return page.path;
  }
  return '/admin/login'; // aucun accès → on renvoie vers le login
}

module.exports = {
  PAGES, RESTRICTABLE_PAGES, PAGE_KEYS, KEY,
  pageKeyForPath,
  getRestrictions, setRestrictions,
  isPageAllowed, allowedPageKeys, firstAllowedPath,
};
