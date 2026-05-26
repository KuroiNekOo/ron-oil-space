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
  // Identité admin exposée à toutes les vues admin (sidebar, etc.).
  // Admin primaire (sans Employee) → libellé générique basé sur le username.
  // Admin secondaire (Employee.isAdmin) → prénom/nom/role réels.
  const initials = s => String(s || '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
  if (user.employee) {
    const fullName = (user.employee.firstName + ' ' + user.employee.lastName).trim();
    res.locals.adminUser = {
      name: fullName,
      role: user.employee.role || 'Administration',
      initials: initials(fullName),
      isPrimary: false,
    };
  } else {
    res.locals.adminUser = {
      name: user.username,
      role: 'Administration',
      initials: initials(user.username),
      isPrimary: true,
    };
  }
  next();
}

// Panel Gouvernement : accessible à deux profils
//   1. Compte Gouvernement (req.session.govId) — accès dédié, lecture seule
//   2. Admin connecté (req.session.userId, primary ou Employee.isAdmin actif) —
//      passerelle pratique pour qu'un admin consulte le panel sans logout
// res.locals.govAccount.isAdmin permet à la sidebar d'adapter l'affichage
// (libellé + bouton "Retour admin" au lieu de déconnexion).
async function requireGov(req, res, next) {
  // 1) Session compte gouvernement
  if (req.session && req.session.govId) {
    const { getGovAccount } = require('../services/govAccount');
    const account = await getGovAccount();
    if (account && account.id === req.session.govId) {
      res.locals.govAccount = { username: account.username, isAdmin: false };
      return next();
    }
  }
  // 2) Session admin (primaire ou Employee.isAdmin actif)
  if (req.session && req.session.userId) {
    const user = await loadSessionUser(req);
    if (user) {
      const isPrimary = user.employeeId === null;
      const isActiveEmployeeAdmin =
        user.employee && user.employee.isAdmin === true && user.employee.status === 'active';
      if (isPrimary || isActiveEmployeeAdmin) {
        const displayName = user.employee
          ? (user.employee.firstName + ' ' + user.employee.lastName).trim()
          : user.username;
        res.locals.govAccount = { username: displayName, isAdmin: true };
        return next();
      }
    }
  }
  return res.redirect('/gouv/login');
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
  // Resynchronise le flag admin avec la BDD : si un admin promeut (ou rétrograde)
  // un employé pendant qu'il est connecté, sa sidebar reflète le changement au
  // prochain refresh sans avoir à se reconnecter.
  const currentIsAdmin = user.employee.isAdmin === true;
  if (req.session.isAdmin !== currentIsAdmin) {
    req.session.isAdmin = currentIsAdmin;
  }
  req.employee = user.employee;

  // Contrat en attente de signature → exposé à toutes les vues employé pour
  // la bannière "Tu dois signer ton contrat". Une requête supplémentaire par
  // hit, mais light (un seul row, index sur (employeeId, status)).
  try {
    const pending = await prisma.contract.findFirst({
      where: { employeeId: user.employee.id, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, signToken: true },
    });
    res.locals.pendingContract = pending || null;
  } catch (e) {
    // Si la table n'existe pas encore (migration pas faite), on ignore
    // silencieusement plutôt que de planter toutes les routes employé.
    res.locals.pendingContract = null;
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireEmployee, requireGov };
