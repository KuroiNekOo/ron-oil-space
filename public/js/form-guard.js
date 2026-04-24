// Désactive les boutons submit des formulaires HTML natifs au moment de la soumission,
// pour éviter les doubles envois (clic nerveux, double-tap mobile…).
// Affiche aussi un spinner dans le bouton pendant la requête.
// S'applique à tous les <form method="POST"> qui ne sont PAS déjà gérés par AdminAjax
// (ceux-là ont leur propre verrou dans admin-ajax.js).
(function () {
  var SPINNER = '<i class="fa-solid fa-spinner fa-spin"></i>';

  function showLoading(btn) {
    if (btn.dataset._origHtml === undefined) {
      btn.dataset._origHtml = btn.innerHTML;
      btn.innerHTML = SPINNER;
    }
    btn.disabled = true;
  }
  function restore(btn) {
    if (btn.dataset._origHtml !== undefined) {
      btn.innerHTML = btn.dataset._origHtml;
      delete btn.dataset._origHtml;
    }
    btn.disabled = false;
  }

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    if ((form.method || '').toLowerCase() !== 'post') return;
    // Si AdminAjax gère ce form, il préventif le default et s'occupe du verrou lui-même.
    if (e.defaultPrevented) return;
    if (form.dataset._busy === '1') {
      e.preventDefault();
      return;
    }
    form.dataset._busy = '1';
    var btns = form.querySelectorAll('button[type="submit"], input[type="submit"]');
    for (var i = 0; i < btns.length; i++) showLoading(btns[i]);
    // Au cas où la navigation serait bloquée (ex. preventDefault plus tard),
    // on réactive après 10s en fallback.
    setTimeout(function () {
      delete form.dataset._busy;
      for (var j = 0; j < btns.length; j++) restore(btns[j]);
    }, 10000);
  }, true);
})();
