function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId || !req.session.isAdmin) {
    return res.redirect('/admin/login');
  }
  next();
}

function requireEmployee(req, res, next) {
  if (!req.session || !req.session.userId || !req.session.employeeId) {
    return res.redirect('/login');
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireEmployee };
