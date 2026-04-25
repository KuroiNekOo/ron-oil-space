require('dotenv').config();

// Timezone du process Node → Europe/Paris par défaut. Garantit que toutes les
// opérations Date (toLocaleString, getDay, getHours, semaine ISO, schedulers
// dim. 18h, etc.) soient cohérentes avec Google Sheets côté utilisateur, peu
// importe la TZ du serveur (typiquement UTC en prod). Peut être surchargé via
// la variable d'env TZ dans .env si besoin.
process.env.TZ = process.env.TZ || 'Europe/Paris';

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Derrière un reverse proxy (nginx / cloudflare), on fait confiance aux en-têtes
// X-Forwarded-* pour que req.protocol reflète bien le https côté public.
// Indispensable pour les URLs absolues (og:url, og:image) envoyées à Discord.
app.set('trust proxy', true);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Static files
app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, '..', 'public', 'js')));
app.use('/img', express.static(path.join(__dirname, '..', 'public', 'img')));

// Body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Sessions persistées (connect-sqlite3 → sessions.db à la racine du projet).
// Les sessions survivent aux redémarrages du serveur.
// Durée configurable via SESSION_DURATION_DAYS dans le .env (défaut 14 jours).
const SESSION_DURATION_DAYS = parseInt(process.env.SESSION_DURATION_DAYS) || 14;
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: path.join(__dirname, '..'),
  }),
  secret: process.env.SESSION_SECRET || 'ron-oil-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000 }
}));

// Make session data + helpers de permission available in all views
const { canRapatriement } = require('./services/permissions');
// Helper pour résoudre le nom d'un employé sur une row qui peut référencer un
// employé supprimé : on fallback sur les colonnes snapshot
// (employeeFirstName/employeeLastName) qui sont écrites à chaque create/upsert.
function empName(row) {
  if (!row) return '—';
  if (row.employee) return row.employee.firstName + ' ' + row.employee.lastName;
  const fn = row.employeeFirstName || '';
  const ln = row.employeeLastName || '';
  const full = (fn + ' ' + ln).trim();
  return full || '—';
}
app.use((req, res, next) => {
  res.locals.session = req.session;
  res.locals.canRapatriement = canRapatriement;
  res.locals.empName = empName;
  next();
});

// Balises Open Graph / Twitter Card exposées dans toutes les vues via res.locals.og.
// Une route peut surcharger (res.locals.og.title = ...) avant res.render().
app.use((req, res, next) => {
  const origin = req.protocol + '://' + req.get('host');
  res.locals.og = {
    siteName: 'RON OIL',
    title: 'RON OIL',
    description: 'Plateforme interne Ron Oil — gestion des livraisons, primes, paies et suivi des employés.',
    url: origin + req.originalUrl,
    image: origin + '/img/ron-oil.png',
    type: 'website',
    themeColor: '#FF5422',
  };
  next();
});

// Routes
const authRoutes = require('./routes/auth');
const employeeRoutes = require('./routes/employee');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');

app.use('/', authRoutes);
app.use('/', employeeRoutes);
app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);

// Root redirect
app.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    if (req.session.employeeId) return res.redirect('/dashboard');
    if (req.session.isAdmin) return res.redirect('/admin/salaries');
  }
  res.redirect('/login');
});

app.listen(PORT, () => {
  console.log(`RON OIL server running on http://localhost:${PORT}`);
  // Schedulers : rollover hebdo + alertes contrats (le bot n'a plus de cron)
  try {
    require('./services/alerts').startSchedulers();
  } catch (err) {
    console.error('[server] startSchedulers failed:', err.message);
  }
});
