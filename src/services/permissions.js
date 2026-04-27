// Wrapper de compat : la source de vérité est services/roles.js
// (Config['roles'] avec flag canRapatriement par rôle).
const { canRapatriement, isRapatriementRole } = require('./roles');

module.exports = { canRapatriement, isRapatriementRole };
