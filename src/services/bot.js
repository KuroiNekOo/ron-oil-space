// Client HTTP vers le bot Discord (ron-bot-v2).
// Le bot n'expose que des endpoints "relais" : on lui donne un payload déjà
// construit, il ne fait que poster les embeds / créer les salons côté Discord.
const BOT_API_URL = process.env.BOT_API_URL || 'http://localhost:3001';
const BOT_API_SECRET = process.env.BOT_API_SECRET || '';

async function call(pathname, body) {
  const res = await fetch(BOT_API_URL + pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-secret': BOT_API_SECRET,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bot API ${pathname} ${res.status}: ${text}`);
  }
  return res.json();
}

async function createCasier({ discordId, firstName, lastName, username, password }) {
  return call('/casier', { discordId, firstName, lastName, username, password });
}

async function archiveCasier({ channelId, discordId }) {
  return call('/casier/archive', { channelId, discordId });
}

async function notifyWeeklyStats(payload) {
  return call('/notify/weekly-stats', payload);
}

async function notifyContractAlert(payload) {
  return call('/notify/contract-alert', payload);
}

module.exports = { createCasier, archiveCasier, notifyWeeklyStats, notifyContractAlert };
