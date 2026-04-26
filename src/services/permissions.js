// Règles d'accès par rôle.
// Le formulaire de rapatriement est réservé aux Superviseurs et plus haut
// dans la hiérarchie (Directeur des Activités, Directeur Général, PDG).
const RAPATRIEMENT_ROLES = [
  'Superviseur',
  'Directeur des Activités',
  'Directeur Général',
  'PDG',
];

function canRapatriement(role) {
  return RAPATRIEMENT_ROLES.includes(role);
}

module.exports = { RAPATRIEMENT_ROLES, canRapatriement };
