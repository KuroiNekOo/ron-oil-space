// Désactive les boutons submit des formulaires HTML natifs au moment de la soumission,
// pour éviter les doubles envois (clic nerveux, double-tap mobile…).
// S'applique à tous les <form method="POST"> qui ne sont PAS déjà gérés par AdminAjax
// (ceux-là ont leur propre verrou dans admin-ajax.js).
(function () {
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
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    // Au cas où la navigation serait bloquée (ex. preventDefault plus tard),
    // on réactive après 10s en fallback.
    setTimeout(function () {
      delete form.dataset._busy;
      for (var j = 0; j < btns.length; j++) btns[j].disabled = false;
    }, 10000);
  }, true);
})();
