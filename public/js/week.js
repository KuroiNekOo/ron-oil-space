// Utilitaire client : numéro de semaine ISO 8601 avec décalage (par défaut +6h).
// Mirroir de src/services/week.js — gardez les deux synchronisés.
(function () {
  function getIsoWeek(date) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    var day = d.getDay() || 7;
    d.setDate(d.getDate() + 4 - day);
    var yearStart = new Date(d.getFullYear(), 0, 1);
    return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  }

  function getWeekFromTimestamp(timestamp, offsetHours) {
    if (offsetHours === undefined) offsetHours = 6;
    var d = new Date(timestamp);
    return getIsoWeek(new Date(d.getTime() + offsetHours * 3600 * 1000));
  }

  window.ronWeek = { getIsoWeek: getIsoWeek, getWeekFromTimestamp: getWeekFromTimestamp };
})();
