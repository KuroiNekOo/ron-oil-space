// Toggle de la sidebar en mode mobile/tablette (sous --bp-lg).
// Séparé de sidebar-collapse.js qui ne gère QUE le pliage des
// sections de navigation (chevrons + localStorage).
//
// Comportement :
//  - .sidebar-toggle dans le DOM → click → ouvre/ferme la sidebar
//  - Overlay sombre injecté dynamiquement → click → ferme
//  - Click sur un .nav-item (lien interne) → ferme
//  - Touche Escape → ferme
//  - body.sidebar-open lock le scroll de la page tant que ouverte
//
// L'auto-refresh.js peut patcher la sidebar : on rebind si besoin
// via l'événement admin:reloaded.
(function () {
  function ensureOverlay() {
    var overlay = document.querySelector('.sidebar-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'sidebar-overlay';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', close);
    }
    return overlay;
  }

  function open() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    var overlay = ensureOverlay();
    sidebar.classList.add('open');
    overlay.classList.add('open');
    document.body.classList.add('sidebar-open');
  }

  function close() {
    var sidebar = document.querySelector('.sidebar');
    var overlay = document.querySelector('.sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
    document.body.classList.remove('sidebar-open');
  }

  function toggle() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    if (sidebar.classList.contains('open')) close();
    else open();
  }

  function bind() {
    document.querySelectorAll('.sidebar-toggle').forEach(function (btn) {
      if (btn._mobileBound) return;
      btn._mobileBound = true;
      btn.addEventListener('click', toggle);
    });

    // Ferme la sidebar quand on clique sur un lien interne ;
    // pratique sur mobile pour ne pas laisser la sidebar ouverte
    // par-dessus la nouvelle page (qui se charge derrière).
    document.querySelectorAll('.sidebar .nav-item').forEach(function (item) {
      if (item._mobileBound) return;
      item._mobileBound = true;
      item.addEventListener('click', function () {
        // Pas de check de viewport ici : sur desktop la sidebar
        // n'est jamais .open, donc close() est un no-op.
        close();
      });
    });
  }

  function init() {
    bind();
    // Escape : raccourci clavier standard pour fermer un overlay.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var sidebar = document.querySelector('.sidebar');
      if (sidebar && sidebar.classList.contains('open')) close();
    });
    // Resize : si on repasse en desktop avec la sidebar ouverte,
    // on nettoie pour éviter que le scroll lock + overlay persistent.
    window.addEventListener('resize', function () {
      if (window.innerWidth >= 1024) close();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  window.addEventListener('admin:reloaded', bind);
})();
