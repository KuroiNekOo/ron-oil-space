const prisma = require('../db');

// Charge l'utilisateur de la session + son employé rattaché (s'il y en a un).
// Renvoie null si pas de session valide.
async function loadSessionUser(req) {
  if (!req.session || !req.session.userId) return null;
  return prisma.user.findUnique({
    where: { id: req.session.userId },
    include: { employee: true },
  });
}

function killSession(req, res, redirectTo) {
  req.session.destroy(() => res.redirect(redirectTo));
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

// Admin : soit admin primaire (User sans employeeId), soit employé avec isAdmin
// ET toujours actif côté Employee. Un employé désactivé ou supprimé voit sa
// session invalidée au premier hit.
async function requireAdmin(req, res, next) {
  const user = await loadSessionUser(req);
  if (!user) return killSession(req, res, '/admin/login');
  const isPrimary = user.employeeId === null;
  const isActiveEmployeeAdmin =
    user.employee && user.employee.isAdmin === true && user.employee.status === 'active';
  if (!isPrimary && !isActiveEmployeeAdmin) {
    return killSession(req, res, '/admin/login');
  }
  next();
}

// Employé : doit avoir un Employee rattaché et son status doit être 'active'.
// Un employé désactivé voit sa session invalidée au premier hit.
// Expose req.employee pour éviter une requête supplémentaire côté handler
// (utile pour snapshoter le nom lors de la création de soumissions).
async function requireEmployee(req, res, next) {
  const user = await loadSessionUser(req);
  if (!user || !user.employeeId || !user.employee) {
    return killSession(req, res, '/login');
  }
  if (user.employee.status !== 'active') {
    return killSession(req, res, '/login');
  }
  req.employee = user.employee;
  next();
}

module.exports = { requireAuth, requireAdmin, requireEmployee };
