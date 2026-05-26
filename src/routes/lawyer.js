// Zone avocat. Deux usages :
//  1. Page de signature individuelle /lawyer/contract/:token — accessible
//     directement par lien partagé, sans session. Le mot de passe LawyerAccount
//     est saisi au moment de la signature.
//  2. Dashboard /lawyer/ — liste tous les contrats avec leur statut. Protégée
//     par session (req.session.lawyerLogged), elle-même posée via /lawyer/login.
//     La signature continue de redemander le mot de passe, même depuis le
//     dashboard — par consigne produit (re-confirmation explicite).
const express = require('express');
const router = express.Router();
const prisma = require('../db');
const { signByLawyer, getLawyerAccount } = require('../services/contracts');

function requireLawyerSession(req, res, next) {
  if (req.session && req.session.lawyerLogged) return next();
  res.redirect('/lawyer/login');
}

// ── Login / Logout ─────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.session && req.session.lawyerLogged) return res.redirect('/lawyer/');
  res.render('lawyer-login', { error: req.query.error });
});

router.post('/login', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (typeof password !== 'string' || !password) {
      return res.redirect('/lawyer/login?error=1');
    }
    const account = await getLawyerAccount();
    if (!account || account.password !== password) {
      return res.redirect('/lawyer/login?error=1');
    }
    // Wipe les autres sessions (admin/employé/gouv) pour rester sur un seul
    // contexte d'auth à la fois — cohérent avec le pattern /gouv/login.
    req.session.userId = undefined;
    req.session.employeeId = undefined;
    req.session.isAdmin = undefined;
    req.session.employeeName = undefined;
    req.session.govId = undefined;
    req.session.lawyerLogged = true;
    res.redirect('/lawyer/');
  } catch (err) {
    console.error('Lawyer login error:', err);
    res.redirect('/lawyer/login?error=1');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/lawyer/login'));
});

// ── Dashboard : liste de tous les contrats ─────────────────────────────────

router.get('/', requireLawyerSession, async (req, res) => {
  try {
    const status = req.query.status || 'all';
    const where = status !== 'all' ? { status } : {};
    const contracts = await prisma.contract.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      take: 500,
    });
    res.render('lawyer-dashboard', { contracts, query: { status } });
  } catch (err) {
    console.error('GET /lawyer/ error:', err);
    res.status(500).send('Erreur serveur');
  }
});

// ── Page de signature individuelle (publique, accessible par lien) ─────────

router.get('/contract/:token', async (req, res) => {
  try {
    const contract = await prisma.contract.findUnique({
      where: { lawyerSignToken: req.params.token },
    });
    if (!contract) return res.status(404).send('Lien invalide ou expiré');
    const lawyerLogged = !!(req.session && req.session.lawyerLogged);
    res.render('lawyer-contract', { contract, error: null, lawyerLogged });
  } catch (err) {
    console.error('GET /lawyer/contract/:token error:', err);
    res.status(500).send('Erreur serveur');
  }
});

router.post('/contract/:token/sign', async (req, res) => {
  try {
    const { password, name, accepted } = req.body || {};
    if (!accepted || (accepted !== 'on' && accepted !== true && accepted !== 'true')) {
      return res.status(400).json({ error: 'Vous devez confirmer la signature' });
    }
    await signByLawyer(req.params.token, {
      password,
      name,
      ip: req.ip || null,
    });
    res.json({ ok: true });
  } catch (err) {
    // Erreurs métier (mauvais mdp, statut incorrect, etc.) → 400. On les expose
    // tel quel : le formulaire les affiche à l'avocat.
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
