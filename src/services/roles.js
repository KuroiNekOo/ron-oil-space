// Liste canonique des rôles + flag "accès au formulaire rapatriement",
// persistée en Config['roles'] (JSON). Cache module-level invalidé par setRoles().
const prisma = require('../db');

const KEY = 'roles';

const DEFAULT_ROLES = [
  { name: 'PDG',                     canRapatriement: true  },
  { name: 'Directeur Général',       canRapatriement: true  },
  { name: 'Directeur des Activités', canRapatriement: true  },
  { name: 'Superviseur',             canRapatriement: true  },
  { name: 'Livreur',                 canRapatriement: false },
];

let _cache = null;

function toBool(v) {
  return v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
}

function sanitize(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const r of input) {
    const name = String((r && r.name) || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, canRapatriement: toBool(r && r.canRapatriement) });
  }
  return out;
}

async function getRoles() {
  if (_cache) return _cache;
  const row = await prisma.config.findUnique({ where: { key: KEY } });
  let roles = [...DEFAULT_ROLES];
  if (row) {
    try {
      const parsed = JSON.parse(row.value);
      const clean = sanitize(parsed);
      if (clean.length) roles = clean;
    } catch {
      // value corrompue → fallback defaults
    }
  }
  _cache = roles;
  return _cache;
}

async function setRoles(input) {
  const clean = sanitize(input);
  if (clean.length === 0) throw new Error('Au moins un rôle est requis');
  await prisma.config.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(clean) },
    update: { value: JSON.stringify(clean) },
  });
  _cache = clean;
  return clean;
}

async function getRoleNames() {
  return (await getRoles()).map(r => r.name);
}

// Variante sync utilisable dans une vue EJS quand la liste est déjà résolue.
function isRapatriementRole(roleName, roles) {
  if (!roleName || !Array.isArray(roles)) return false;
  const r = roles.find(x => x.name === roleName);
  return !!(r && r.canRapatriement);
}

async function canRapatriement(roleName) {
  return isRapatriementRole(roleName, await getRoles());
}

module.exports = {
  DEFAULT_ROLES,
  getRoles, setRoles, getRoleNames,
  isRapatriementRole, canRapatriement,
};
