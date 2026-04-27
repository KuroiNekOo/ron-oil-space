// Auto-submit (avec débounce) des barres de recherche server-side.
// S'applique à tout <input class="admin-search" name="q"> dans un <form>.
// Reset implicite de la pagination (le form ne contient pas `page` → repart à 1).
(function () {
  var DEBOUNCE_MS = 350;
  document.querySelectorAll('input.admin-search[name="q"]').forEach(function (input) {
    var form = input.form;
    if (!form) return;
    var timer = null;
    input.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { form.submit(); }, DEBOUNCE_MS);
    });
  });
})();
