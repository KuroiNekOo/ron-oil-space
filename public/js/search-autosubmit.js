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
    // Deux contrôles de reset distincts :
    //  - clearBtn : "X" intégré dans l'input, n'efface que la recherche (q='')
    //  - resetLink : lien à côté des filtres, reset complet (toolbar-reset-link
    //    sur les pages avec selects, ou créé dynamiquement sinon)
    var searchWrap = input.closest('.admin-search-wrap');
    var clearBtn = searchWrap ? searchWrap.querySelector('.admin-search-clear') : null;
    var resetLink = form.querySelector('.toolbar-reset-link') || form.querySelector('a[href]');

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

    function hasNonSearchFilters() {
      var active = false;
      form.querySelectorAll('select[name]').forEach(function (sel) {
        if (!isDefaultSelect(sel)) active = true;
      });
      return active;
    }
    function hasActiveFilters() {
      return !!input.value.trim() || hasNonSearchFilters();
    }

    // X intégré dans l'input : visible dès qu'il y a du texte. Créé à la volée
    // s'il n'est pas déjà rendu côté EJS, pour rester réactif à la frappe.
    function syncClearBtn() {
      if (!searchWrap) return;
      var shouldShow = !!input.value.trim();
      if (shouldShow && !clearBtn) {
        clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'admin-search-clear';
        clearBtn.title = 'Effacer la recherche';
        clearBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        searchWrap.appendChild(clearBtn);
      }
      if (clearBtn) clearBtn.style.display = shouldShow ? '' : 'none';
    }

    // Lien "Réinitialiser" complet : visible si filtres non-recherche actifs
    // (sur les pages avec selects). On ne le crée plus dynamiquement quand
    // seule la recherche est active : le X dans l'input suffit, le lien fait
    // doublon.
    function syncResetLink() {
      var shouldShow = hasNonSearchFilters();
      if (!resetLink) return;
      resetLink.style.display = shouldShow ? '' : 'none';
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

    syncClearBtn();
    syncResetLink();

    input.addEventListener('input', function () {
      syncClearBtn();
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

    // X intégré dans l'input : n'efface que la recherche, garde les filtres.
    // On délègue au form pour capter aussi le X créé dynamiquement par syncClearBtn.
    form.addEventListener('click', function (e) {
      var t = e.target;
      var clear = t && t.closest && t.closest('.admin-search-clear');
      if (clear && form.contains(clear)) {
        e.preventDefault();
        input.value = '';
        syncClearBtn();
        if (timer) clearTimeout(timer);
        runSearch();
        input.focus();
        return;
      }
      // Lien Réinitialiser complet → vide tout (recherche + filtres) et relance.
      // Pour les <select>, on remet la première option (convention "all" / "default").
      var resetA = t && t.closest && t.closest('a[href]');
      if (resetA && form.contains(resetA) && !resetA.closest('.admin-search-wrap')) {
        e.preventDefault();
        input.value = '';
        form.querySelectorAll('select[name]').forEach(function (sel) {
          if (sel.options.length) sel.selectedIndex = 0;
        });
        syncClearBtn();
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
