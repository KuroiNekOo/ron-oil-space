// Rafraîchissement automatique du contenu de <main> toutes les N secondes,
// via DOM morphing : on patche les attributs et le texte des éléments existants
// au lieu de remplacer le HTML → pas de destruction/recréation, pas de
// re-déclenchement des transitions CSS (progress bars, etc.).
//
// Actif uniquement quand l'onglet est visible.
// Émet 'admin:reloaded' après chaque patch pour que les pages réhydratent leurs caches.
(function () {
  var INTERVAL = 5000;
  var inFlight = false;

  function patchAttrs(from, to) {
    var toA = to.attributes;
    for (var i = 0; i < toA.length; i++) {
      if (from.getAttribute(toA[i].name) !== toA[i].value) from.setAttribute(toA[i].name, toA[i].value);
    }
    var fromA = from.attributes;
    for (var j = fromA.length - 1; j >= 0; j--) {
      if (!to.hasAttribute(fromA[j].name)) from.removeAttribute(fromA[j].name);
    }
  }

  function patch(from, to) {
    // Texte et commentaires : maj de la valeur, pas d'attributs à patcher.
    if ((from.nodeType === 3 || from.nodeType === 8) && from.nodeType === to.nodeType) {
      if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
      return;
    }
    if (from.nodeType !== to.nodeType || from.tagName !== to.tagName) {
      from.replaceWith(to.cloneNode(true));
      return;
    }
    if (from.tagName === 'SCRIPT') {
      if ((from.getAttribute('type') || '') === 'application/json') {
        if (from.textContent !== to.textContent) from.textContent = to.textContent;
      } else if (from.outerHTML !== to.outerHTML) {
        from.replaceWith(to.cloneNode(true));
      }
      return;
    }
    if (from.tagName === 'STYLE') {
      if (from.textContent !== to.textContent) from.textContent = to.textContent;
      return;
    }
    patchAttrs(from, to);
    var len = Math.min(from.childNodes.length, to.childNodes.length);
    for (var k = 0; k < len; k++) patch(from.childNodes[k], to.childNodes[k]);
    for (var m = len; m < to.childNodes.length; m++) {
      from.appendChild(to.childNodes[m].cloneNode(true));
    }
    while (from.childNodes.length > to.childNodes.length) {
      from.removeChild(from.lastChild);
    }
  }

  function isBusy() {
    // Suspend le refresh si l'utilisateur est en train de saisir ou si un modal est ouvert
    // (les tables admin ont des modals d'édition qui se fermeraient sinon).
    if (document.querySelector('.modal-overlay.open')) return true;
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return true;
    return false;
  }

  function softReload() {
    if (inFlight) return;
    if (document.visibilityState !== 'visible') return;
    if (isBusy()) return;
    inFlight = true;
    // Cache-busting query param : évite qu'un proxy/navigateur serve une page stale.
    var sep = window.location.search ? '&' : '?';
    var url = window.location.pathname + window.location.search + sep + '_ts=' + Date.now();
    fetch(url, {
      headers: { Accept: 'text/html', 'Cache-Control': 'no-cache' },
      credentials: 'same-origin',
    })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) {
        if (!html) return;
        var doc = new DOMParser().parseFromString(html, 'text/html');

        // Patche chaque zone "live" : sidebar (numéro de semaine, nav items
        // conditionnels) + contenu principal.
        [['aside', 'aside'], ['main', 'main']].forEach(function (pair) {
          var next = doc.querySelector(pair[1]);
          var curr = document.querySelector(pair[0]);
          if (next && curr) patch(curr, next);
        });

        doc.querySelectorAll('script[type="application/json"]').forEach(function (s) {
          if (!s.id) return;
          var existing = document.getElementById(s.id);
          if (!existing) return;
          if (existing.textContent !== s.textContent) existing.textContent = s.textContent;
        });

        window.dispatchEvent(new CustomEvent('admin:reloaded'));
      })
      .catch(function () {})
      .finally(function () { inFlight = false; });
  }

  setInterval(softReload, INTERVAL);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') softReload();
  });
})();
