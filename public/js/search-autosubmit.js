// Recherche server-side en AJAX : on remplace uniquement la .card (table +
// pagination) au lieu de soumettre le form, ce qui préserverait le focus de
// l'input pendant la frappe.
//
// S'applique à tout <input class="admin-search" name="q"> dans un <form>.
// Reset implicite de la pagination (le form ne contient pas `page` → repart à 1).
//
// Compatibilité auto-refresh : le polling de auto-refresh.js suspend pendant
// que l'input a le focus (isBusy), et lit window.location.search → il reprendra
// avec la query active dès que l'input perd le focus.
(function () {
  var DEBOUNCE_MS = 350;

  document.querySelectorAll('input.admin-search[name="q"]').forEach(function (input) {
    var form = input.form;
    if (!form) return;
    var card = form.parentElement && form.parentElement.querySelector(':scope > .card');
    if (!card) return;

    var action = form.getAttribute('action') || window.location.pathname;
    var resetLink = form.querySelector('a[href]');

    // Sérialise tous les champs nommés du form. La valeur "neutre" d'un <select>
    // est sa première option : ainsi un select rendu en `selected="type-asc"` au
    // chargement initial est considéré comme par défaut tant que l'utilisateur
    // n'a pas changé sa sélection.
    function isDefaultSelect(sel) {
      return sel.options.length > 0 && sel.value === sel.options[0].value;
    }

    function buildUrl() {
      var params = new URLSearchParams();
      if (input.name && input.value.trim()) {
        params.append(input.name, input.value.trim());
      }
      form.querySelectorAll('select[name]').forEach(function (sel) {
        if (!isDefaultSelect(sel)) params.append(sel.name, sel.value);
      });
      var qs = params.toString();
      return action + (qs ? '?' + qs : '');
    }

    function hasActiveFilters() {
      if (input.value.trim()) return true;
      var active = false;
      form.querySelectorAll('select[name]').forEach(function (sel) {
        if (!isDefaultSelect(sel)) active = true;
      });
      return active;
    }

    function syncResetLink() {
      var hasQuery = hasActiveFilters();
      if (hasQuery) {
        if (!resetLink) {
          resetLink = document.createElement('a');
          resetLink.href = action;
          resetLink.style.fontSize = '12px';
          resetLink.style.color = 'var(--text-muted)';
          resetLink.textContent = 'Réinitialiser';
          form.appendChild(resetLink);
        }
        resetLink.style.display = '';
      } else if (resetLink) {
        resetLink.style.display = 'none';
      }
    }

    var timer = null;
    var abortCtrl = null;
    var seq = 0;

    function load(url) {
      var mySeq = ++seq;
      if (abortCtrl) abortCtrl.abort();
      abortCtrl = new AbortController();

      card.style.transition = 'opacity 120ms';
      card.style.opacity = '0.55';

      fetch(url, {
        headers: { Accept: 'text/html' },
        credentials: 'same-origin',
        signal: abortCtrl.signal,
      })
        .then(function (r) { return r.ok ? r.text() : null; })
        .then(function (html) {
          if (mySeq !== seq || !html) return;
          var doc = new DOMParser().parseFromString(html, 'text/html');
          var newCard = doc.querySelector('main > .card');
          if (newCard) {
            card.replaceWith(newCard);
            card = newCard;
          }
          history.replaceState(null, '', url);
        })
        .catch(function (err) {
          if (err && err.name === 'AbortError') return;
        })
        .finally(function () {
          if (mySeq === seq) card.style.opacity = '';
        });
    }

    function runSearch() { load(buildUrl()); }

    syncResetLink();

    input.addEventListener('input', function () {
      syncResetLink();
      if (timer) clearTimeout(timer);
      timer = setTimeout(runSearch, DEBOUNCE_MS);
    });

    // Entrée → déclenche tout de suite, sans attendre le debounce.
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (timer) clearTimeout(timer);
      runSearch();
    });

    // <select> du form (filtres dropdown, tri) → submit immédiat sans debounce.
    // On scope sur les selects qui ont un `name` pour ignorer ceux d'usage purement
    // visuel.
    form.querySelectorAll('select[name]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        if (timer) clearTimeout(timer);
        runSearch();
      });
    });

    // Lien Réinitialiser → vide tous les filtres et relance en AJAX, garde le focus.
    // Pour les <select>, on remet la première option (convention "all" / "default").
    form.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.tagName === 'A' && form.contains(t)) {
        e.preventDefault();
        input.value = '';
        form.querySelectorAll('select[name]').forEach(function (sel) {
          if (sel.options.length) sel.selectedIndex = 0;
        });
        syncResetLink();
        if (timer) clearTimeout(timer);
        runSearch();
        input.focus();
      }
    });

    // Pagination en AJAX : on délègue au parent stable (les liens sont dans
    // la card, qu'on remplace à chaque load → écouter sur le main est plus sûr).
    // On ne capture que les hrefs query-only (`?page=...`) générés par
    // partials/pagination.ejs ; ouverture nouvel onglet (Ctrl/Cmd/Shift/middle)
    // garde le comportement natif.
    form.parentElement.addEventListener('click', function (e) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a || !card.contains(a)) return;
      var href = a.getAttribute('href');
      if (!href || href.charAt(0) !== '?') return;
      e.preventDefault();
      if (timer) clearTimeout(timer);
      load(action + href);
    });
  });
})();
