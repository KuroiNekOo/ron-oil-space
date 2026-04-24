// Règles d'accès par rôle.
// Le formulaire de rapatriement est réservé aux Superviseurs et plus.
const RAPATRIEMENT_ROLES = ['Superviseur', 'Direction', 'PDG'];

function canRapatriement(role) {
  return RAPATRIEMENT_ROLES.includes(role);
}

module.exports = { RAPATRIEMENT_ROLES, canRapatriement };
