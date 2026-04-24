// Semaine ISO 8601 + année ISO associée (différente de l'année civile en fin/début
// d'année : ex. 31/12/2027 appartient à la semaine 52 de 2027 OU à la semaine 1 de 2028
// selon le jour de la semaine). On applique systématiquement un offset +6h avant
// le calcul ISO pour que la fenêtre entreprise soit dim. 18h → dim. 18h.

function getIsoWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - day); // jeudi de la semaine ISO
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// Année ISO : année contenant le jeudi de la semaine (= année à laquelle la semaine appartient).
function getIsoWeekYear(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - day);
  return d.getFullYear();
}

function shift(timestamp, offsetHours) {
  return new Date(new Date(timestamp).getTime() + offsetHours * 3600 * 1000);
}

// Semaine d'un horodatage avec offset (+6h par défaut : dim. 18h bascule en S+1).
function getWeekFromTimestamp(timestamp, offsetHours = 6) {
  return getIsoWeek(shift(timestamp, offsetHours));
}

// Année ISO d'un horodatage avec le même offset.
function getYearFromTimestamp(timestamp, offsetHours = 6) {
  return getIsoWeekYear(shift(timestamp, offsetHours));
}

// Retourne { week, year } d'un coup — pratique pour les imports.
function getWeekAndYear(timestamp, offsetHours = 6) {
  const d = shift(timestamp, offsetHours);
  return { week: getIsoWeek(d), year: getIsoWeekYear(d) };
}

// Retourne les bornes réelles dim. 18h → dim. 18h (heure locale) d'une semaine ISO donnée.
// Exemple : weekBounds(13, 2026) → { startDate: 22/03/2026 18:00, endDate: 29/03/2026 18:00 }.
function weekBounds(week, year, offsetHours = 6) {
  // Le 4 janvier est toujours dans la semaine 1 (ISO 8601).
  const jan4 = new Date(year, 0, 4);
  const jan4Day = jan4.getDay() || 7; // 1 = lundi
  // Lundi de la semaine voulue à 00:00 local
  const monday = new Date(year, 0, 4 - (jan4Day - 1) + (week - 1) * 7);
  // Dimanche précédent à (24 - offsetHours):00 local — construit via setDate/setHours
  // pour que l'heure locale 18:00 soit respectée même autour d'un changement d'heure (DST).
  const startDate = new Date(monday);
  startDate.setDate(startDate.getDate() - 1);
  startDate.setHours(24 - offsetHours, 0, 0, 0);
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 7);
  endDate.setHours(24 - offsetHours, 0, 0, 0);
  return { startDate, endDate };
}

module.exports = {
  getIsoWeek,
  getIsoWeekYear,
  getWeekFromTimestamp,
  getYearFromTimestamp,
  getWeekAndYear,
  weekBounds,
};
