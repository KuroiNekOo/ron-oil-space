// Migration one-shot : ajoute le flag `isDirection` aux rôles existants stockés
// en Config['roles'] (introduit avec la restriction de pages par rôle).
//
// Sans ce flag, sanitize() le considère `false` pour tous les rôles déjà
// persistés → seuls les admins primaires garderaient l'accès aux pages
// Direction (Rôles, Accès). On marque Direction tout rôle dont le nom
// correspond aux rôles de direction par défaut (PDG, Directeur *).
//
// Usage : node scripts/migrate-direction-flag.js
// Idempotent : peut être relancé sans effet de bord.

const prisma = require('../src/db');
const { DEFAULT_ROLES } = require('../src/services/roles');

const KEY = 'roles';
const DIRECTION_DEFAULT_NAMES = new Set(
  DEFAULT_ROLES.filter(r => r.isDirection).map(r => r.name)
);

function looksLikeDirection(name) {
  if (DIRECTION_DEFAULT_NAMES.has(name)) return true;
  return /(^|\s)(PDG|Directeur|Direction)/i.test(name);
}

async function main() {
  const row = await prisma.config.findUnique({ where: { key: KEY } });
  if (!row) {
    console.log('[migrate] aucune Config["roles"] — rien à migrer (les défauts portent déjà isDirection).');
    return;
  }

  let roles;
  try {
    roles = JSON.parse(row.value);
  } catch {
    console.log('[migrate] Config["roles"] illisible — ignorée.');
    return;
  }
  if (!Array.isArray(roles)) {
    console.log('[migrate] Config["roles"] inattendue — ignorée.');
    return;
  }

  let changed = 0;
  const out = roles.map(r => {
    const name = String((r && r.name) || '').trim();
    const next = {
      name,
      canRapatriement: !!(r && (r.canRapatriement === true || r.canRapatriement === 'true' || r.canRapatriement === 'on')),
      isDirection: !!(r && (r.isDirection === true || r.isDirection === 'true' || r.isDirection === 'on')),
    };
    if (!('isDirection' in (r || {})) && looksLikeDirection(name)) {
      next.isDirection = true;
    }
    if (next.isDirection !== !!(r && r.isDirection)) changed++;
    return next;
  });

  await prisma.config.update({ where: { key: KEY }, data: { value: JSON.stringify(out) } });
  console.log(`[migrate] Config["roles"] mise à jour : ${changed} rôle(s) marqué(s) Direction.`);
  out.forEach(r => console.log(`  - ${r.name} : direction=${r.isDirection} rapatriement=${r.canRapatriement}`));
  console.log('[migrate] terminé.');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
