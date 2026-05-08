// Compte Gouvernement : singleton (une seule ligne en base).
// Mot de passe stocké en clair pour pouvoir l'afficher et le copier depuis
// /admin/gouv (compte de service externe partagé, pas un compte employé).
const crypto = require('crypto');
const prisma = require('../db');

const DEFAULT_USERNAME = 'gouvernement';

function generatePassword(length = 14) {
  return crypto.randomBytes(length * 2)
    .toString('base64')
    .replace(/[+/=Il0O]/g, '')
    .slice(0, length);
}

// Retourne le compte existant, ou en crée un avec un mot de passe aléatoire
// si aucun n'existe encore. Premier accès admin → compte initial généré.
async function getOrCreateGovAccount() {
  const existing = await prisma.govAccount.findFirst({ orderBy: { id: 'asc' } });
  if (existing) return existing;
  return prisma.govAccount.create({
    data: { username: DEFAULT_USERNAME, password: generatePassword() },
  });
}

async function getGovAccount() {
  return prisma.govAccount.findFirst({ orderBy: { id: 'asc' } });
}

async function updateGovAccount({ username, password }) {
  const account = await getOrCreateGovAccount();
  const data = {};
  if (typeof username === 'string') {
    const cleaned = username.trim();
    if (!cleaned) throw new Error('Le nom d\'utilisateur ne peut pas être vide');
    data.username = cleaned;
  }
  if (typeof password === 'string') {
    if (!password) throw new Error('Le mot de passe ne peut pas être vide');
    data.password = password;
  }
  if (Object.keys(data).length === 0) return account;
  return prisma.govAccount.update({ where: { id: account.id }, data });
}

async function regeneratePassword() {
  const account = await getOrCreateGovAccount();
  return prisma.govAccount.update({
    where: { id: account.id },
    data: { password: generatePassword() },
  });
}

module.exports = {
  getOrCreateGovAccount,
  getGovAccount,
  updateGovAccount,
  regeneratePassword,
  generatePassword,
};
