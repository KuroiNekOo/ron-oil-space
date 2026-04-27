// Replier / déplier les catégories de la sidebar.
// État persisté dans localStorage et réappliqué après chaque soft-reload
// d'auto-refresh.js (qui réécrase l'attribut class du <aside>).
(function () {
  var KEY = 'sidebar-collapsed';

  function getSaved() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }

  function setSaved(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
  }

  function applyState() {
    var saved = getSaved();
    document.querySelectorAll('.nav-section[data-section]').forEach(function (section) {
      var key = section.getAttribute('data-section');
      // Section contenant la page active : forcée déployée pour ne jamais cacher l'item courant.
      var hasActive = !!section.querySelector('.nav-item.active');
      section.classList.toggle('collapsed', !!saved[key] && !hasActive);
    });
  }

  function bind() {
    document.querySelectorAll('.nav-section[data-section] .nav-section-label').forEach(function (label) {
      // Propriété JS plutôt que data-attribute : le patcher d'auto-refresh.js
      // efface les data-* absents côté serveur, alors que les props survivent.
      if (label._collapseBound) return;
      label._collapseBound = true;
      label.addEventListener('click', function () {
        var section = label.closest('.nav-section');
        if (!section) return;
        var key = section.getAttribute('data-section');
        if (!key) return;
        section.classList.toggle('collapsed');
        var saved = getSaved();
        saved[key] = section.classList.contains('collapsed');
        setSaved(saved);
      });
    });
  }

  function init() {
    applyState();
    bind();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // auto-refresh.js patche les attributs du <aside> et nous repasse dessus
  // → on réapplique l'état + on rebind les nouveaux noeuds éventuels.
  window.addEventListener('admin:reloaded', init);
})();
