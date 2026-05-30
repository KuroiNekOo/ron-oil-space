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
    // Type-check explicite : un body JSON peut envoyer un objet (`{match_all:{}}`)
    // que `!username` ne rejette pas → Prisma crashe ensuite. Bloque les scans
    // NoSQL-injection à l'entrée.
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
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
    req.session.govId = undefined;

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
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
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
    req.session.govId = undefined;

    res.redirect('/admin/salaries');
  } catch (err) {
    console.error('Admin login error:', err);
    res.redirect('/admin/login?error=1');
  }
});

// ── Page publique : liste des employés actifs (vitrine partenaires) ──

router.get('/equipe', async (req, res) => {
  try {
    const employees = await prisma.employee.findMany({
      where: { status: 'active', showInTeam: true },
      select: { firstName: true, lastName: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    res.render('equipe', { employees });
  } catch (err) {
    console.error('GET /equipe error:', err);
    res.status(500).send('Erreur serveur');
  }
});

// ── Page publique : bourse (livraisons en direct, sans login) ──

// Référentiel statique des 31 stations Ron Oil (clé snake_case + libellé pretty
// + coordonnées GTA5 pour la map Leaflet). Pas de table en DB — la liste est
// figée côté code (cf. Configuration.lua du script in-game).
const BOURSE_STATIONS = [
  { key: 'great_ocean_highway',  label: 'Great Ocean Highway',  x: -282.44,    y: 5889.25  },
  { key: 'paleto_boulevard',     label: 'Paleto Boulevard',     x: -512.11, y: 5733.44  },
  { key: 'senora_freeway_2',     label: 'Senora Freeway 2',     x: 992.42, y: 5732.34  },
  { key: 'grapeseed_main_street', label: 'Grapeseed Main Street', x: 992.99, y: 4482.57  },
  { key: 'senora_freeway',       label: 'Senora Freeway',       x: 1828.5, y: 3077.75  },
  { key: 'panorama_drive',       label: 'Panorama Drive',       x: 1061.63, y: 3125.4  },
  { key: 'alhambra_drive',       label: 'Alhambra Drive',       x: 1258.82, y: 3501.28  },
  { key: 'route_68_4',           label: 'Route 68 #4',          x: 579.74, y: 2564.23  },
  { key: 'route_68_5',           label: 'Route 68 #5',          x: 443.57, y: 2571.96  },
  { key: 'route_68_3',           label: 'Route 68 #3',          x: -217.5, y: 2512.88  },
  { key: 'route_68_2',           label: 'Route 68 #2',          x: -397.32, y: 2665.01   },
  { key: 'route_68',             label: 'Route 68',             x: -2580.94, y: 2285.02  },
  { key: 'senora_way',           label: 'Senora Way',           x: 1709, y: 2499.5  },
  { key: 'north_rockford_drive', label: 'North Rockford Drive', x: -1951.72, y: 998.56   },
  { key: 'palomino_freeway',     label: 'Palomino Freeway',     x: 1743.51, y: 617.54     },
  { key: 'del_perro_freeway',    label: 'Del Perro Freeway',    x: -2202.57, y: 43.48  },
  { key: 'south_rockford_drive', label: 'South Rockford Drive', x: -1648.15, y: 81.85  },
  { key: 'clinton_avenue',       label: 'Clinton Avenue',       x: 88, y: 541.25   },
  { key: 'mirror_park_boulevard', label: 'Mirror Park Boulevard', x: 564, y: 33.75   },
  { key: 'popular_street',       label: 'Popular Street',       x: 256, y: -553.25 },
  { key: 'capital_boulevard',    label: 'Capital Boulevard',    x: 584.22, y: -866.93  },
  { key: 'grove_street',         label: 'Grove Street',         x: -496.04, y: -1170.44 },
  { key: 'alta_street',          label: 'Alta Street',          x: -701.1, y: -924.37 },
  { key: 'strawberry_avenue',    label: 'Strawberry Avenue',    x: -217.03, y: -752.02 },
  { key: 'calais_avenue',        label: 'Calais Avenue',        x: -882.52, y: -713.29 },
  { key: 'lindsay_circus',       label: 'Lindsay Circus',       x: -1041.87, y: -471.95  },
  { key: 'davis_avenue',         label: 'Davis Avenue',         x: -290.11, y: -1002.14 },
  { key: 'ss_airport',           label: 'SS Airport',           x: 981.33, y: 3114.89 },
  { key: 'elysian_island',       label: 'Elysian Island',       x: -492.93, y: -1822.76 },
  { key: 'la_puerta',            label: 'La Puerta',            x: -1076.23, y: -895.77 },
  { key: 'lsx',                  label: 'LSX',                  x: -1837.18, y: -2342.11 },
];

router.get('/bourse', (req, res) => {
  res.locals.og = {
    ...res.locals.og,
    title: 'RON OIL — Bourse',
    description: 'Activité des livraisons Ron Oil en direct, station par station.',
  };
  res.render('bourse', { stations: BOURSE_STATIONS });
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
