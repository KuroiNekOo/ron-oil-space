const express = require('express');
const router = express.Router();
const prisma = require('../db');
const bcrypt = require('bcrypt');

// ── Employee login ──

router.get('/login', (req, res) => {
  res.render('login', { error: req.query.error });
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.redirect('/login?error=1');
    }

    const user = await prisma.user.findUnique({
      where: { username },
      include: { employee: true },
    });

    if (!user || !user.employeeId || !user.employee) {
      return res.redirect('/login?error=1');
    }
    if (user.employee.status !== 'active') {
      return res.redirect('/login?error=1');
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.redirect('/login?error=1');
    }

    req.session.userId = user.id;
    req.session.employeeId = user.employeeId;
    req.session.isAdmin = user.employee.isAdmin === true;
    req.session.employeeName = `${user.employee.firstName} ${user.employee.lastName}`;

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    res.redirect('/login?error=1');
  }
});

// ── Admin login ──

router.get('/admin/login', (req, res) => {
  res.render('admin-login', { error: req.query.error });
});

router.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.redirect('/admin/login?error=1');
    }

    const user = await prisma.user.findUnique({
      where: { username },
      include: { employee: true },
    });

    if (!user) {
      return res.redirect('/admin/login?error=1');
    }

    const isPrimary = user.employeeId === null;
    const isActiveEmployeeAdmin =
      user.employee?.isAdmin === true && user.employee?.status === 'active';
    if (!isPrimary && !isActiveEmployeeAdmin) {
      return res.redirect('/admin/login?error=1');
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.redirect('/admin/login?error=1');
    }

    req.session.userId = user.id;
    req.session.employeeId = user.employeeId;
    req.session.isAdmin = true;
    req.session.employeeName = user.employee
      ? `${user.employee.firstName} ${user.employee.lastName}`
      : 'Admin';

    res.redirect('/admin/salaries');
  } catch (err) {
    console.error('Admin login error:', err);
    res.redirect('/admin/login?error=1');
  }
});

// ── Logout ──

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

router.get('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

module.exports = router;
