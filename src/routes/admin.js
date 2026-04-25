const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const prisma = require('../db');
const bcrypt = require('bcrypt');
const { requireAdmin } = require('../middleware/auth');
const { createCasier, archiveCasier, deactivateCasier, reactivateCasier } = require('../services/bot');
const { computeFrozenWeek } = require('../services/rollover');
const { getWeekFromTimestamp, getYearFromTimestamp, getWeekAndYear } = require('../services/week');
const { getBonusRates, setBonusRate } = require('../services/bonus');
const {
  getTiers, setTiers,
  getTierPrimeShares, setTierPrimeShares,
  getPodiumPrizes, setPodiumPrizes,
  getPointsPerGain, setPointsPerGain,
  getBonusMinDeliveries, setBonusMinDeliveries,
  getWeeklyDeliveryQuota, setWeeklyDeliveryQuota,
} = require('../services/tiers');
const {
  getRepatCostPerEvent, setRepatCostPerEvent,
  getRepatReimbursementPercent, setRepatReimbursementPercent,
  getImpoundCostPerEvent, setImpoundCostPerEvent,
  getImpoundReimbursementPercent, setImpoundReimbursementPercent,
} = require('../services/reimbursements');
const {
  getExpenseTypes, createExpenseType, updateExpenseType, deleteExpenseType,
} = require('../services/expenseTypes');

// ── Helpers : génération d'identifiants ──

function generatePassword(length = 16) {
  // base64url sans caractères ambigus
  return crypto.randomBytes(length * 2)
    .toString('base64')
    .replace(/[+/=Il0O]/g, '')
    .slice(0, length);
}

async function generateUniqueUsername(firstName, lastName) {
  const base = `${firstName}.${lastName}`
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.]/g, '')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');

  let candidate = base || `user${Date.now()}`;
  let i = 0;
  while (await prisma.user.findUnique({ where: { username: candidate } })) {
    i++;
    if (i > 50) throw new Error('Impossible de générer un username unique');
    candidate = `${base}${i}`;
  }
  return candidate;
}

// Une semaine est "figée" dès qu'une ligne WeekStats existe pour (week, year).
// Toute action admin sur une donnée de cette semaine est alors rejetée.
async function isWeekFrozen(week, year) {
  if (!week || !year) return false;
  const row = await prisma.weekStats.findFirst({ where: { week, year } });
  return !!row;
}

// Set<"week|year"> de toutes les semaines figées — passé aux vues admin pour
// masquer les boutons d'édition/suppression sur les lignes concernées.
async function getFrozenWeekKeys() {
  const rows = await prisma.weekStats.findMany({
    select: { week: true, year: true },
    distinct: ['week', 'year'],
  });
  return new Set(rows.map(r => r.week + '|' + r.year));
}

// All routes protected
router.use(requireAdmin);

// ══════════════════════════════════════
//  SALARIES
// ══════════════════════════════════════

router.get('/salaries', async (req, res) => {
  try {
    const [employees, dutyLogs] = await Promise.all([
      prisma.employee.findMany({ orderBy: { id: 'asc' } }),
      prisma.logEntry.findMany({
        where: { type: 'duty' },
        orderBy: { timestamp: 'desc' },
        select: { data: true, timestamp: true },
      }),
    ]);

    // Dernier log de service par nom normalisé (first-wins car trié desc).
    const dutyByName = new Map();
    for (const log of dutyLogs) {
      let d;
      try { d = JSON.parse(log.data); } catch { continue; }
      const name = String(d[0] || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!name) continue;
      if (dutyByName.has(name)) continue;
      dutyByName.set(name, { onDuty: d[1] === 'true', since: log.timestamp });
    }

    const enriched = employees.map(e => {
      const key = (e.firstName + ' ' + e.lastName).trim().toLowerCase().replace(/\s+/g, ' ');
      const duty = dutyByName.get(key) || null;
      return { ...e, duty };
    });

    res.render('admin/salaries', { employees: enriched });
  } catch (err) {
    console.error('GET /salaries error:', err);
    res.status(500).send('Erreur serveur');
  }
});

router.post('/salaries', async (req, res) => {
  try {
    const {
      firstName, lastName, contract, role, phone,
      hireDate, endDate, iban, discordId, notes,
    } = req.body;

    if (!discordId) {
      return res.status(400).json({ error: 'ID Discord requis' });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Téléphone requis' });
    }
    if (!endDate) {
      return res.status(400).json({ error: 'Date de fin de contrat requise' });
    }

    const username = await generateUniqueUsername(firstName, lastName);
    const password = generatePassword(16);
    const hashedPassword = await bcrypt.hash(password, 10);

    // Employee + User créés en transaction : si le User foire, l'Employee est rollback.
    const employee = await prisma.$transaction(async (tx) => {
      const emp = await tx.employee.create({
        data: {
          firstName,
          lastName,
          contract: contract || 'CDD',
          role: role || 'Livreur',
          phone: phone || null,
          hireDate: hireDate ? new Date(hireDate) : new Date(),
          endDate: endDate ? new Date(endDate) : null,
          iban: iban || null,
          discordId,
          notes: notes || null,
        },
      });
      await tx.user.create({
        data: { username, password: hashedPassword, employeeId: emp.id },
      });
      return emp;
    });

    // Création du casier Discord. Si ça échoue, on rollback Employee + User
    // (la transaction Prisma est déjà committée, donc cleanup manuel).
    try {
      const { channelId } = await createCasier({
        discordId, firstName, lastName, username, password,
      });
      await prisma.employee.update({
        where: { id: employee.id },
        data: { channelId, casierId: channelId },
      });
    } catch (botErr) {
      console.error('Bot casier failed, rollback employee:', botErr.message);
      try {
        await prisma.$transaction([
          prisma.user.deleteMany({ where: { employeeId: employee.id } }),
          prisma.employee.delete({ where: { id: employee.id } }),
        ]);
      } catch (cleanupErr) {
        console.error('Cleanup failed:', cleanupErr.message);
      }
      return res.status(502).json({
        error: 'Impossible de créer le casier Discord : ' + botErr.message,
      });
    }

    res.json({ ok: true, id: employee.id });
  } catch (err) {
    console.error('POST /salaries error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Récap d'un employé pour la modal admin : stats live de la semaine en cours
// (computeFrozenWeek à blanc, sans sauvegarde) + historique figé des semaines
// précédentes. Ne dépend pas de WeekStats pour la semaine courante (qui n'est
// jamais figée tant que le rollover n'a pas tourné).
router.get('/salaries/:id/recap', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const employee = await prisma.employee.findUnique({ where: { id } });
    if (!employee) return res.status(404).json({ error: 'Not found' });

    const { week: currentWeek, year: currentYear } = getWeekAndYear(new Date());
    const liveRows = await computeFrozenWeek(currentWeek, currentYear);
    const live = liveRows.find(r => r.employee.id === id) || null;
    const current = live ? {
      week: currentWeek,
      year: currentYear,
      rank: live.rank,
      deliveries: live.deliveries,
      gainEnterprise: live.gainEnterprise,
      gainEmployee: live.gainEmployee,
      bonusSalary: live.bonusSalary,
      tierLevel: live.tierLevel,
      tierPrime: live.tierPrime,
      podiumPrize: live.podiumPrize,
      specialBonus: live.specialBonus,
      specialBonusReason: live.specialBonusReason,
      expenseRefund: live.expenseRefund,
      expenseCost: live.expenseCost,
      repatBonus: live.repatBonus,
      repatCount: live.repatCount,
      impoundReimbursement: live.impoundReimbursement,
      impoundPenalty: live.impoundPenalty,
      impoundCount: live.impoundCount,
      primeFinale: live.primeFinale,
    } : { week: currentWeek, year: currentYear, empty: true };

    const history = await prisma.weekStats.findMany({
      where: {
        employeeId: id,
        NOT: { AND: [{ week: currentWeek }, { year: currentYear }] },
      },
      orderBy: [{ year: 'desc' }, { week: 'desc' }],
    });

    res.json({
      employee: {
        id: employee.id,
        firstName: employee.firstName,
        lastName: employee.lastName,
        role: employee.role,
        contract: employee.contract,
        status: employee.status,
      },
      current,
      history,
    });
  } catch (err) {
    console.error('GET /salaries/:id/recap error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/salaries/:id/edit', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const {
      firstName, lastName, contract, role, phone,
      hireDate, endDate, iban, discordId, casierId, notes,
    } = req.body;

    // ID casier manuel : on synchronise channelId et casierId (le bot lit channelId)
    const casier = casierId && casierId.trim() ? casierId.trim() : null;

    await prisma.employee.update({
      where: { id },
      data: {
        firstName,
        lastName,
        contract: contract || 'CDD',
        role: role || 'Livreur',
        phone: phone || null,
        hireDate: hireDate ? new Date(hireDate) : undefined,
        endDate: endDate ? new Date(endDate) : null,
        iban: iban || null,
        discordId: discordId || null,
        casierId: casier,
        channelId: casier,
        notes: notes || null,
      },
    });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /salaries/:id/edit error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/salaries/:id/toggle', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const employee = await prisma.employee.findUnique({ where: { id } });
    if (!employee) return res.status(404).json({ error: 'Not found' });
    const newStatus = employee.status === 'active' ? 'inactive' : 'active';
    const updated = await prisma.employee.update({
      where: { id },
      data: { status: newStatus },
    });

    // Best-effort côté Discord : rename salon + swap rôles selon la transition.
    // On ne bloque PAS le toggle BDD si le bot est down.
    let botWarning = null;
    const channelId = employee.channelId || employee.casierId || null;
    if (channelId || employee.discordId) {
      try {
        const fn = newStatus === 'inactive' ? deactivateCasier : reactivateCasier;
        await fn({
          channelId,
          discordId: employee.discordId,
          firstName: employee.firstName,
          lastName: employee.lastName,
        });
      } catch (botErr) {
        console.warn('[salaries/toggle] bot ' + newStatus + ' failed:', botErr.message);
        botWarning = botErr.message;
      }
    }

    res.json({ id: updated.id, status: updated.status, botWarning });
  } catch (err) {
    console.error('POST /salaries/:id/toggle error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/salaries/:id/toggle-admin', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const employee = await prisma.employee.findUnique({ where: { id } });
    if (!employee) return res.status(404).json({ error: 'Not found' });
    const updated = await prisma.employee.update({
      where: { id },
      data: { isAdmin: !employee.isAdmin },
    });
    res.json({ id: updated.id, isAdmin: updated.isAdmin });
  } catch (err) {
    console.error('POST /salaries/:id/toggle-admin error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/salaries/:id/delete', async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // Récupéré AVANT la suppression pour pouvoir archiver le casier ensuite.
    const employee = await prisma.employee.findUnique({ where: { id } });
    if (!employee) return res.status(404).json({ error: 'Not found' });

    await prisma.user.deleteMany({ where: { employeeId: id } });
    await prisma.employee.delete({ where: { id } });

    // Archive Discord en best-effort — on ne bloque PAS la suppression BDD
    // si le bot est down. L'admin verra juste un warning côté réponse.
    let botWarning = null;
    const channelId = employee.channelId || employee.casierId || null;
    if (channelId || employee.discordId) {
      try {
        await archiveCasier({
          channelId,
          discordId: employee.discordId,
          firstName: employee.firstName,
          lastName: employee.lastName,
        });
      } catch (botErr) {
        console.warn('[salaries/delete] archiveCasier failed:', botErr.message);
        botWarning = botErr.message;
      }
    }

    res.json({ ok: true, id, botWarning });
  } catch (err) {
    console.error('POST /salaries/:id/delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════
//  VEHICULES
// ══════════════════════════════════════

router.get('/vehicules', async (req, res) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      include: {
        maintenances: {
          orderBy: { date: 'desc' },
          take: 1,
        },
        _count: { select: { maintenances: true } },
      },
      orderBy: { id: 'asc' },
    });
    res.render('admin/vehicules', { vehicles });
  } catch (err) {
    console.error('GET /vehicules error:', err);
    res.status(500).send('Erreur serveur');
  }
});

router.post('/vehicules', async (req, res) => {
  try {
    const { plate, type } = req.body;
    const vehicle = await prisma.vehicle.create({
      data: { plate, type: type || 'Camion' },
    });
    res.json({ ok: true, id: vehicle.id });
  } catch (err) {
    console.error('POST /vehicules error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/vehicules/:id/toggle', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const vehicle = await prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) return res.status(404).json({ error: 'Not found' });
    const updated = await prisma.vehicle.update({
      where: { id },
      data: { status: vehicle.status === 'active' ? 'inactive' : 'active' },
    });
    res.json({ id: updated.id, status: updated.status });
  } catch (err) {
    console.error('POST /vehicules/:id/toggle error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/vehicules/:id/delete', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.vehicle.delete({ where: { id } });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /vehicules/:id/delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/vehicules/:id/maintenance', async (req, res) => {
  try {
    const vehicleId = parseInt(req.params.id);
    const { date, miles, notes } = req.body;
    const maintenance = await prisma.maintenance.create({
      data: {
        vehicleId,
        date: new Date(date),
        miles: parseInt(miles),
        notes: notes || null,
      },
    });
    res.json({ ok: true, id: maintenance.id });
  } catch (err) {
    console.error('POST /vehicules/:id/maintenance error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/vehicules/:id/maintenances', async (req, res) => {
  try {
    const vehicleId = parseInt(req.params.id);
    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 5;

    const [maintenances, total] = await Promise.all([
      prisma.maintenance.findMany({
        where: { vehicleId },
        orderBy: { date: 'desc' },
        skip: page * limit,
        take: limit,
      }),
      prisma.maintenance.count({ where: { vehicleId } }),
    ]);

    res.json({ maintenances, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('GET /vehicules/:id/maintenances error:', err);
    res.json({ maintenances: [], total: 0, page: 0, limit: 5, totalPages: 0 });
  }
});

// ══════════════════════════════════════
//  ACHATS
// ══════════════════════════════════════

router.get('/achats', async (req, res) => {
  try {
    const [purchases, types, employees] = await Promise.all([
      prisma.purchase.findMany({
        include: { type: true, employee: true },
        orderBy: { id: 'desc' },
      }),
      prisma.purchaseType.findMany({ orderBy: { name: 'asc' } }),
      prisma.employee.findMany({
        where: { status: 'active' },
        orderBy: { firstName: 'asc' },
      }),
    ]);
    const currentWeek = getWeekFromTimestamp(new Date());
    res.render('admin/achats', { purchases, types, employees, currentWeek });
  } catch (err) {
    console.error('GET /achats error:', err);
    res.status(500).send('Erreur serveur');
  }
});

router.post('/achats', async (req, res) => {
  try {
    const { typeId, employeeId, qty, unitPrice, date, description, week } = req.body;

    const purchaseDate = date ? new Date(date) : new Date();
    const wy = getWeekAndYear(purchaseDate);
    const weekNum = parseInt(week) || wy.week;

    const purchase = await prisma.purchase.create({
      data: {
        week: weekNum,
        typeId: parseInt(typeId),
        employeeId: employeeId ? parseInt(employeeId) : null,
        qty: parseFloat(qty),
        unitPrice: parseFloat(unitPrice),
        date: purchaseDate,
        description: description || '',
      },
    });
    res.json({ ok: true, id: purchase.id });
  } catch (err) {
    console.error('POST /achats error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/achats/:id/delete', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.purchase.delete({ where: { id } });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /achats/:id/delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Purchase types JSON API
router.get('/achats/types', async (req, res) => {
  try {
    const types = await prisma.purchaseType.findMany({ orderBy: { name: 'asc' } });
    res.json(types);
  } catch (err) {
    console.error('GET /achats/types error:', err);
    res.json([]);
  }
});

router.post('/achats/types', async (req, res) => {
  try {
    const { name } = req.body;
    const type = await prisma.purchaseType.create({ data: { name } });
    res.json(type);
  } catch (err) {
    console.error('POST /achats/types error:', err);
    res.status(400).json({ error: 'Impossible de créer le type' });
  }
});

router.put('/achats/types/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name } = req.body;
    const type = await prisma.purchaseType.update({ where: { id }, data: { name } });
    res.json(type);
  } catch (err) {
    console.error('PUT /achats/types/:id error:', err);
    res.status(400).json({ error: 'Impossible de renommer le type' });
  }
});

router.delete('/achats/types/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.purchaseType.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /achats/types/:id error:', err);
    res.status(400).json({ error: 'Impossible de supprimer le type' });
  }
});

// ══════════════════════════════════════
//  FORM SUBMISSIONS (read-only)
// ══════════════════════════════════════

router.get('/absences', async (req, res) => {
  try {
    const [absences, frozenKeys] = await Promise.all([
      prisma.absence.findMany({
        where: { employee: { status: 'active' } },
        include: { employee: true },
        orderBy: { createdAt: 'desc' },
      }),
      getFrozenWeekKeys(),
    ]);
    res.render('admin/absences', { absences, frozenKeys });
  } catch (err) {
    console.error('GET /absences error:', err);
    res.status(500).send('Erreur serveur');
  }
});

router.post('/absences/:id/edit', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.absence.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (await isWeekFrozen(existing.week, existing.year)) {
      return res.status(409).json({ error: 'Semaine figée, action interdite' });
    }
    const { type, dateStart, dateEnd, justificatif, comment } = req.body;
    await prisma.absence.update({
      where: { id },
      data: {
        type,
        dateStart: dateStart ? new Date(dateStart) : undefined,
        dateEnd: dateEnd ? new Date(dateEnd) : undefined,
        justificatif: justificatif || null,
        comment: comment || null,
      },
    });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /absences/:id/edit error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/absences/:id/delete', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.absence.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (await isWeekFrozen(existing.week, existing.year)) {
      return res.status(409).json({ error: 'Semaine figée, action interdite' });
    }
    await prisma.absence.delete({ where: { id } });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /absences/:id/delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/frais', async (req, res) => {
  try {
    const [expenses, frozenKeys, expenseTypes] = await Promise.all([
      prisma.expense.findMany({
        where: { employee: { status: 'active' } },
        include: { employee: true },
        orderBy: { createdAt: 'desc' },
      }),
      getFrozenWeekKeys(),
      getExpenseTypes(),
    ]);
    res.render('admin/frais', { expenses, frozenKeys, expenseTypes });
  } catch (err) {
    console.error('GET /frais error:', err);
    res.status(500).send('Erreur serveur');
  }
});

router.post('/frais/:id/edit', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.expense.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (await isWeekFrozen(existing.week, existing.year)) {
      return res.status(409).json({ error: 'Semaine figée, action interdite' });
    }
    const { type, amount, comment } = req.body;
    await prisma.expense.update({
      where: { id },
      data: {
        type,
        amount: parseFloat(amount),
        comment: comment || null,
      },
    });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /frais/:id/edit error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/frais/:id/delete', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.expense.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (await isWeekFrozen(existing.week, existing.year)) {
      return res.status(409).json({ error: 'Semaine figée, action interdite' });
    }
    await prisma.expense.delete({ where: { id } });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /frais/:id/delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/pannes', async (req, res) => {
  try {
    const [breakdowns, frozenKeys] = await Promise.all([
      prisma.breakdown.findMany({
        where: { employee: { status: 'active' } },
        include: { employee: true },
        orderBy: { createdAt: 'desc' },
      }),
      getFrozenWeekKeys(),
    ]);
    res.render('admin/pannes', { breakdowns, frozenKeys });
  } catch (err) {
    console.error('GET /pannes error:', err);
    res.status(500).send('Erreur serveur');
  }
});

router.post('/pannes/:id/edit', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.breakdown.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (await isWeekFrozen(existing.week, existing.year)) {
      return res.status(409).json({ error: 'Semaine figée, action interdite' });
    }
    const { truckPlate, tankerPlate, type, position, comment } = req.body;
    await prisma.breakdown.update({
      where: { id },
      data: {
        truckPlate,
        tankerPlate: tankerPlate || null,
        type,
        position,
        comment: comment || null,
      },
    });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /pannes/:id/edit error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/pannes/:id/delete', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.breakdown.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (await isWeekFrozen(existing.week, existing.year)) {
      return res.status(409).json({ error: 'Semaine figée, action interdite' });
    }
    await prisma.breakdown.delete({ where: { id } });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /pannes/:id/delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/rapatriements', async (req, res) => {
  try {
    const [repatriations, frozenKeys] = await Promise.all([
      prisma.repatriation.findMany({
        where: { employee: { status: 'active' } },
        include: { employee: true },
        orderBy: { createdAt: 'desc' },
      }),
      getFrozenWeekKeys(),
    ]);
    res.render('admin/rapatriements', { repatriations, frozenKeys });
  } catch (err) {
    console.error('GET /rapatriements error:', err);
    res.status(500).send('Erreur serveur');
  }
});

router.post('/rapatriements/:id/edit', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.repatriation.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (await isWeekFrozen(existing.week, existing.year)) {
      return res.status(409).json({ error: 'Semaine figée, action interdite' });
    }
    const { truckPlate, tankerPlate, fuel, departure, comment } = req.body;
    await prisma.repatriation.update({
      where: { id },
      data: {
        truckPlate,
        tankerPlate: tankerPlate || null,
        fuel: parseInt(fuel),
        departure: departure || null,
        comment: comment || null,
      },
    });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /rapatriements/:id/edit error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/rapatriements/:id/delete', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.repatriation.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (await isWeekFrozen(existing.week, existing.year)) {
      return res.status(409).json({ error: 'Semaine figée, action interdite' });
    }
    await prisma.repatriation.delete({ where: { id } });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /rapatriements/:id/delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════
//  PRIMES DE LIVRAISON (taux par rôle)
// ══════════════════════════════════════

router.get('/primes', async (req, res) => {
  try {
    const [
      roles, rates, specialBonuses, employees,
      tiers, tierShares, podiumPrizes, pointsPerGain,
      bonusMinDeliveries, weeklyDeliveryQuota, frozenKeys,
      expenseTypes, repatCostPerEvent, repatReimbursementPercent,
      impoundCostPerEvent, impoundReimbursementPercent,
    ] = await Promise.all([
      prisma.employee.findMany({
        distinct: ['role'],
        select: { role: true },
        orderBy: { role: 'asc' },
      }),
      getBonusRates(),
      prisma.specialBonus.findMany({
        where: { employee: { status: 'active' } },
        include: { employee: true },
        orderBy: [{ week: 'desc' }, { id: 'desc' }],
      }),
      prisma.employee.findMany({
        where: { status: 'active' },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
      getTiers(),
      getTierPrimeShares(),
      getPodiumPrizes(),
      getPointsPerGain(),
      getBonusMinDeliveries(),
      getWeeklyDeliveryQuota(),
      getFrozenWeekKeys(),
      getExpenseTypes(),
      getRepatCostPerEvent(),
      getRepatReimbursementPercent(),
      getImpoundCostPerEvent(),
      getImpoundReimbursementPercent(),
    ]);
    const rows = roles
      .map(r => r.role)
      .filter(Boolean)
      .map(role => ({ role, rate: rates[role] || 0 }));
    const { week: currentWeek, year: currentYear } = getWeekAndYear(new Date());
    res.render('admin/primes', {
      rows, specialBonuses, employees, currentWeek, currentYear,
      tiers, tierShares, podiumPrizes, pointsPerGain,
      bonusMinDeliveries, weeklyDeliveryQuota, frozenKeys,
      expenseTypes,
      repatCostPerEvent, repatReimbursementPercent,
      impoundCostPerEvent, impoundReimbursementPercent,
    });
  } catch (err) {
    console.error('GET /primes error:', err);
    res.status(500).send('Erreur serveur');
  }
});

// ── Config remboursements : rapatriements + fourrières ──
// (les notes de frais passent par /admin/expense-types, voir plus bas)
router.post('/reimbursements', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.repatCostPerEvent != null && body.repatCostPerEvent !== '') {
      await setRepatCostPerEvent(body.repatCostPerEvent);
    }
    if (body.repatReimbursementPercent != null && body.repatReimbursementPercent !== '') {
      await setRepatReimbursementPercent(body.repatReimbursementPercent);
    }
    if (body.impoundCostPerEvent != null && body.impoundCostPerEvent !== '') {
      await setImpoundCostPerEvent(body.impoundCostPerEvent);
    }
    if (body.impoundReimbursementPercent != null && body.impoundReimbursementPercent !== '') {
      await setImpoundReimbursementPercent(body.impoundReimbursementPercent);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /reimbursements error:', err);
    res.status(400).json({ error: err.message });
  }
});

// ── Types de notes de frais : CRUD (parallèle à /admin/achats/types) ──
router.get('/expense-types', async (req, res) => {
  try {
    res.json(await getExpenseTypes());
  } catch (err) {
    console.error('GET /expense-types error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/expense-types', async (req, res) => {
  try {
    const { key, label, reimbursementPercent } = req.body || {};
    const type = await createExpenseType({ key, label, reimbursementPercent });
    res.json(type);
  } catch (err) {
    console.error('POST /expense-types error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.put('/expense-types/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const type = await updateExpenseType(id, req.body || {});
    res.json(type);
  } catch (err) {
    console.error('PUT /expense-types/:id error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.delete('/expense-types/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await deleteExpenseType(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /expense-types/:id error:', err);
    res.status(400).json({ error: 'Impossible de supprimer le type' });
  }
});

router.post('/primes', async (req, res) => {
  try {
    for (const key of Object.keys(req.body || {})) {
      if (!key.startsWith('rate.')) continue;
      const role = key.slice('rate.'.length);
      await setBonusRate(role, parseFloat(req.body[key]) || 0);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /primes error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Config paliers : grille + équivalence points + répartition podium ──
router.post('/tier-config', async (req, res) => {
  try {
    const body = req.body || {};

    // Équivalence : pointsPerGain (gain entreprise $ pour 1 pt)
    if (body.pointsPerGain != null) {
      await setPointsPerGain(body.pointsPerGain);
    }

    // Quotas de livraisons
    if (body.bonusMinDeliveries != null && body.bonusMinDeliveries !== '') {
      await setBonusMinDeliveries(body.bonusMinDeliveries);
    }
    if (body.weeklyDeliveryQuota != null && body.weeklyDeliveryQuota !== '') {
      await setWeeklyDeliveryQuota(body.weeklyDeliveryQuota);
    }

    // Répartition podium : share.1, share.2, share.3 en pourcentage (%)
    const sharesRaw = {};
    for (const k of Object.keys(body)) {
      if (!k.startsWith('share.')) continue;
      const rank = parseInt(k.slice('share.'.length));
      if (!rank) continue;
      const pct = parseFloat(body[k]);
      if (!isFinite(pct)) continue;
      sharesRaw[rank] = pct / 100;
    }
    if (Object.keys(sharesRaw).length > 0) {
      await setTierPrimeShares(sharesRaw);
    }

    // Prix podium fixes : podium.1, podium.2, podium.3 en $
    const podiumRaw = {};
    for (const k of Object.keys(body)) {
      if (!k.startsWith('podium.')) continue;
      const rank = parseInt(k.slice('podium.'.length));
      if (!rank) continue;
      const amt = parseFloat(body[k]);
      if (!isFinite(amt) || amt < 0) continue;
      podiumRaw[rank] = amt;
    }
    if (Object.keys(podiumRaw).length > 0) {
      await setPodiumPrizes(podiumRaw);
    }

    // Grille paliers : tiers[] avec level / points / prime en tableau parallèle
    const tiersIn = [];
    const levels = body['tier.level'] || [];
    const points = body['tier.points'] || [];
    const primes = body['tier.prime'] || [];
    const levelArr = Array.isArray(levels) ? levels : [levels];
    const pointArr = Array.isArray(points) ? points : [points];
    const primeArr = Array.isArray(primes) ? primes : [primes];
    for (let i = 0; i < levelArr.length; i++) {
      const lvl = parseInt(levelArr[i]);
      const pts = parseInt(pointArr[i]);
      const prm = parseFloat(primeArr[i]);
      if (!lvl) continue;
      tiersIn.push({ level: lvl, points: isNaN(pts) ? 0 : pts, prime: isNaN(prm) ? 0 : prm });
    }
    if (tiersIn.length > 0) {
      await setTiers(tiersIn);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /tier-config error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Primes spéciales (bonus manuel par employé et semaine) ──

router.post('/special-bonus', async (req, res) => {
  try {
    const { employeeId, week, year, amount, reason } = req.body;
    const empId = parseInt(employeeId);
    const w = parseInt(week);
    const y = parseInt(year) || getYearFromTimestamp(new Date());
    const amt = parseFloat(amount);
    if (!empId || !w || isNaN(amt)) {
      return res.status(400).json({ error: 'employeeId, week et amount requis' });
    }
    if (await isWeekFrozen(w, y)) {
      return res.status(409).json({ error: 'Semaine figée, action interdite' });
    }
    const bonus = await prisma.specialBonus.upsert({
      where: { employeeId_week_year: { employeeId: empId, week: w, year: y } },
      create: { employeeId: empId, week: w, year: y, amount: amt, reason: reason || null },
      update: { amount: amt, reason: reason || null },
    });
    res.json({ ok: true, id: bonus.id });
  } catch (err) {
    console.error('POST /special-bonus error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/special-bonus/:id/delete', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const bonus = await prisma.specialBonus.findUnique({ where: { id } });
    if (!bonus) return res.status(404).json({ error: 'Not found' });
    if (await isWeekFrozen(bonus.week, bonus.year)) {
      return res.status(409).json({ error: 'Semaine figée, action interdite' });
    }
    await prisma.specialBonus.delete({ where: { id } });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /special-bonus/:id/delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════
//  DATA PAGES (LogEntry par type)
// ══════════════════════════════════════

async function paginateLogs(type, req) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(500, Math.max(10, parseInt(req.query.limit) || 100));
  const q = (req.query.q || '').trim();
  const where = { type };
  if (q) where.rawData = { contains: q };

  const [rows, total] = await Promise.all([
    prisma.logEntry.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.logEntry.count({ where }),
  ]);

  return {
    rows,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    query: { q, limit },
  };
}

// Parse une ligne LogEntry et applique le mapper. Retourne null si la data est corrompue
// (ligne ignorée dans l'affichage — ne crash plus la route).
function mapLogRow(r, mapper) {
  let d;
  try {
    d = JSON.parse(r.data);
  } catch (e) {
    console.warn('[admin] LogEntry ' + r.id + ' data invalide, ligne ignorée:', e.message);
    return null;
  }
  return mapper(r, d);
}

// ══════════════════════════════════════
//  STATISTIQUES
// ══════════════════════════════════════

function sumWeekStats(rows) {
  let livraisons = 0, gainEnterprise = 0, gainEmployee = 0;
  let bonusSalary = 0, tierPrime = 0, podiumPrize = 0, specialBonus = 0;
  let expenseRefund = 0, repatBonus = 0, impoundReimbursement = 0;
  let impoundPenalty = 0, expenseCost = 0, primeFinale = 0;
  for (const r of rows) {
    livraisons    += r.deliveries || 0;
    gainEnterprise += r.gainEnterprise || 0;
    gainEmployee   += r.gainEmployee || 0;
    bonusSalary    += r.bonusSalary || 0;
    tierPrime      += r.tierPrime || 0;
    podiumPrize    += r.podiumPrize || 0;
    specialBonus   += r.specialBonus || 0;
    expenseRefund  += r.expenseRefund || 0;
    expenseCost    += r.expenseCost || 0;
    repatBonus     += r.repatBonus || 0;
    impoundReimbursement += r.impoundReimbursement || 0;
    impoundPenalty += r.impoundPenalty || 0;
    primeFinale    += r.primeFinale || 0;
  }
  const totalPrimes = bonusSalary + tierPrime + podiumPrize + specialBonus;
  const totalFrais  = expenseRefund + repatBonus + impoundReimbursement;
  return {
    livraisons, gainEnterprise, gainEmployee,
    bonusSalary, tierPrime, podiumPrize, specialBonus, totalPrimes,
    expenseRefund, expenseCost, repatBonus, impoundReimbursement, totalFrais,
    impoundPenalty, primeFinale,
    activeEmployees: rows.length,
  };
}

router.get('/statistiques', async (req, res) => {
  try {
    const { week: currentWeek, year: currentYear } = getWeekAndYear(new Date());

    // Semaine en cours : on calcule "à blanc" (computeFrozenWeek ne sauve rien)
    // pour avoir le même format que les WeekStats figés.
    // Filtrage employee.status='active' sur l'historique : un employé désactivé
    // disparaît des stats jusqu'à réactivation (ses WeekStats restent en BDD).
    const [liveRows, allFrozen, allPurchases] = await Promise.all([
      computeFrozenWeek(currentWeek, currentYear),
      prisma.weekStats.findMany({
        where: {
          NOT: { AND: [{ week: currentWeek }, { year: currentYear }] },
          employee: { status: 'active' },
        },
        include: { employee: true },
        orderBy: [{ year: 'desc' }, { week: 'desc' }],
      }),
      // Charge tous les achats : on dérive l'année ISO depuis la date pour pouvoir
      // les agréger par (year, week) sans dépendre du champ Purchase.week qui n'a
      // pas d'année associée.
      prisma.purchase.findMany({ select: { date: true, qty: true, unitPrice: true } }),
    ]);

    const purchasesByWeek = new Map();
    for (const p of allPurchases) {
      const { week, year } = getWeekAndYear(p.date);
      const k = year + '|' + week;
      purchasesByWeek.set(k, (purchasesByWeek.get(k) || 0) + (p.qty || 0) * (p.unitPrice || 0));
    }

    const liveTop = liveRows.slice().sort((a, b) => b.gainEnterprise - a.gainEnterprise);
    const currentTotals = sumWeekStats(liveRows);
    currentTotals.achats = purchasesByWeek.get(currentYear + '|' + currentWeek) || 0;
    currentTotals.totalDepenses =
      currentTotals.totalPrimes + currentTotals.totalFrais + currentTotals.achats;
    currentTotals.beneficeNet = currentTotals.gainEnterprise - currentTotals.totalDepenses;

    const byWeek = new Map();
    for (const r of allFrozen) {
      const k = r.year + '|' + r.week;
      if (!byWeek.has(k)) byWeek.set(k, { week: r.week, year: r.year, rows: [] });
      byWeek.get(k).rows.push(r);
    }
    const history = Array.from(byWeek.values()).map(w => {
      const totals = sumWeekStats(w.rows);
      totals.achats = purchasesByWeek.get(w.year + '|' + w.week) || 0;
      totals.totalDepenses = totals.totalPrimes + totals.totalFrais + totals.achats;
      totals.beneficeNet = totals.gainEnterprise - totals.totalDepenses;
      return {
        week: w.week, year: w.year,
        totals,
        rows: w.rows.map(r => ({
          employeeId: r.employeeId,
          name: r.employee ? r.employee.firstName + ' ' + r.employee.lastName : '—',
          deliveries: r.deliveries,
          gainEnterprise: r.gainEnterprise,
          gainEmployee: r.gainEmployee,
          bonusSalary: r.bonusSalary,
          tierPrime: r.tierPrime,
          podiumPrize: r.podiumPrize,
          specialBonus: r.specialBonus,
          expenseRefund: r.expenseRefund,
          repatBonus: r.repatBonus,
          impoundReimbursement: r.impoundReimbursement,
          impoundPenalty: r.impoundPenalty,
          primeFinale: r.primeFinale,
          rank: r.rank,
        })).sort((a, b) => b.gainEnterprise - a.gainEnterprise),
      };
    });

    res.render('admin/statistiques', {
      currentWeek, currentYear,
      currentTotals,
      currentTop: liveTop.map(r => ({
        employeeId: r.employee.id,
        name: r.employee.firstName + ' ' + r.employee.lastName,
        deliveries: r.deliveries,
        gainEnterprise: r.gainEnterprise,
        gainEmployee: r.gainEmployee,
        bonusSalary: r.bonusSalary,
        tierPrime: r.tierPrime,
        podiumPrize: r.podiumPrize,
        specialBonus: r.specialBonus,
        expenseRefund: r.expenseRefund,
        repatBonus: r.repatBonus,
        impoundReimbursement: r.impoundReimbursement,
        primeFinale: r.primeFinale,
        rank: r.rank,
      })),
      history,
    });
  } catch (err) {
    console.error('GET /statistiques error:', err);
    res.status(500).send('Erreur serveur');
  }
});

router.get('/standard', async (req, res) => {
  try {
    const result = await paginateLogs('call', req);
    const rows = result.rows.map(r => mapLogRow(r, (r, d) => ({
      id: r.id, timestamp: r.timestamp, week: r.week,
      phoneNumber: d[0] || '',
      answered: d[1] === 'true',
      duration: parseInt(d[2]) || 0,
    }))).filter(Boolean);
    res.render('admin/standard', { ...result, rows });
  } catch (err) {
    console.error('GET /standard error:', err);
    res.status(500).send('Erreur serveur');
  }
});

router.get('/livraisons', async (req, res) => {
  try {
    const result = await paginateLogs('delivery', req);
    const rows = result.rows.map(r => mapLogRow(r, (r, d) => {
      // d[5] = prix de la station après livraison. Absent sur les anciens logs.
      const rawPrice = d[5];
      const price = rawPrice != null && rawPrice !== '' && !isNaN(parseFloat(rawPrice))
        ? parseFloat(rawPrice)
        : null;
      return {
        id: r.id, timestamp: r.timestamp, week: r.week,
        employee: d[0] || '',
        station: d[1] || '',
        qty: parseFloat(d[2]) || 0,
        gainEmployee: parseFloat(d[3]) || 0,
        gainEnterprise: parseFloat(d[4]) || 0,
        price,
      };
    })).filter(Boolean);
    res.render('admin/livraisons', { ...result, rows });
  } catch (err) {
    console.error('GET /livraisons error:', err);
    res.status(500).send('Erreur serveur');
  }
});

router.get('/facturations', async (req, res) => {
  try {
    const result = await paginateLogs('invoice', req);
    const rows = result.rows.map(r => mapLogRow(r, (r, d) => ({
      id: r.id, timestamp: r.timestamp, week: r.week,
      destinataire: d[0] || '',
      montant: parseFloat(d[1]) || 0,
      raison: d[2] || '',
      employee: d[3] || '',
    }))).filter(Boolean);
    res.render('admin/facturations', { ...result, rows });
  } catch (err) {
    console.error('GET /facturations error:', err);
    res.status(500).send('Erreur serveur');
  }
});

router.get('/entrees-sorties', async (req, res) => {
  try {
    const result = await paginateLogs('garage', req);
    const rows = result.rows.map(r => mapLogRow(r, (r, d) => ({
      id: r.id, timestamp: r.timestamp, week: r.week,
      employee: d[0] || '',
      plate: d[1] || '',
      isOut: d[2] === 'true',
    }))).filter(Boolean);
    res.render('admin/entrees-sorties', { ...result, rows });
  } catch (err) {
    console.error('GET /entrees-sorties error:', err);
    res.status(500).send('Erreur serveur');
  }
});

router.get('/services', async (req, res) => {
  try {
    const result = await paginateLogs('duty', req);
    const rows = result.rows.map(r => mapLogRow(r, (r, d) => ({
      id: r.id, timestamp: r.timestamp, week: r.week,
      employee: d[0] || '',
      onDuty: d[1] === 'true',
    }))).filter(Boolean);
    res.render('admin/services', { ...result, rows });
  } catch (err) {
    console.error('GET /services error:', err);
    res.status(500).send('Erreur serveur');
  }
});

module.exports = router;
