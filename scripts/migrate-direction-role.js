// Migration one-shot : renomme tous les Employee.role === 'Direction'
// en 'Directeur des Activités' + déplace la Config bonusRate.Direction
// vers bonusRate.Directeur des Activités si présente.
//
// Usage : node scripts/migrate-direction-role.js
//
// Idempotent : peut être lancé plusieurs fois sans effet de bord.

const prisma = require('../src/db');

const FROM = 'Direction';
const TO = 'Directeur des Activités';

async function main() {
  const updated = await prisma.employee.updateMany({
    where: { role: FROM },
    data: { role: TO },
  });
  console.log(`[migrate] employees ${FROM} → ${TO} : ${updated.count} ligne(s)`);

  const fromKey = 'bonusRate.' + FROM;
  const toKey = 'bonusRate.' + TO;
  const fromCfg = await prisma.config.findUnique({ where: { key: fromKey } });
  if (fromCfg) {
    const toCfg = await prisma.config.findUnique({ where: { key: toKey } });
    if (toCfg) {
      console.log(`[migrate] ${toKey} existe déjà (valeur ${toCfg.value}) — suppression de ${fromKey} sans écrasement`);
      await prisma.config.delete({ where: { key: fromKey } });
    } else {
      await prisma.config.upsert({
        where: { key: toKey },
        create: { key: toKey, value: fromCfg.value },
        update: { value: fromCfg.value },
      });
      await prisma.config.delete({ where: { key: fromKey } });
      console.log(`[migrate] ${fromKey} (${fromCfg.value}) → ${toKey}`);
    }
  } else {
    console.log(`[migrate] aucune config ${fromKey} à migrer`);
  }

  console.log('[migrate] terminé.');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
