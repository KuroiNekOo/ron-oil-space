// Helpers AJAX pour les pages admin.
// - postForm(form)  : POST le formulaire, renvoie le JSON
// - post(url)       : POST simple, renvoie le JSON
// - reloadMain()    : refetch la page courante, remplace le contenu de <main>
//                     et les <script type="application/json" id="…"> (caches de données).
//                     Émet un événement 'admin:reloaded' pour que les pages réactualisent
//                     leurs caches JS locaux.
(function () {
  function parseResponse(r) {
    if (!r.ok) {
      return r.text().then(function (t) { throw new Error(t || 'HTTP ' + r.status); });
    }
    return r.json();
  }

  // Désactive tous les boutons submit du formulaire pendant la requête pour empêcher
  // les double-clics. Restauré dans tous les cas (succès / erreur).
  function lockSubmits(form) {
    var btns = form.querySelectorAll('button[type="submit"], input[type="submit"]');
    var wasDisabled = [];
    for (var i = 0; i < btns.length; i++) {
      wasDisabled.push(btns[i].disabled);
      btns[i].disabled = true;
      btns[i].dataset._busy = '1';
    }
    return function unlock() {
      for (var j = 0; j < btns.length; j++) {
        btns[j].disabled = wasDisabled[j];
        delete btns[j].dataset._busy;
      }
    };
  }

  function postForm(form) {
    // Garde-fou : ignore la soumission si une requête est déjà en vol pour ce form
    if (form.dataset._busy === '1') return Promise.reject(new Error('Requête déjà en cours'));
    form.dataset._busy = '1';
    var unlock = lockSubmits(form);
    var body = new URLSearchParams(new FormData(form));
    return fetch(form.action, {
      method: 'POST',
      body: body,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
    }).then(parseResponse).finally(function () {
      unlock();
      delete form.dataset._busy;
    });
  }

  // Map {url: inFlightPromise} → le deuxième appel sur la même URL attend le premier
  var pendingPosts = {};
  function post(url) {
    if (pendingPosts[url]) return pendingPosts[url];
    var p = fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    }).then(parseResponse).finally(function () { delete pendingPosts[url]; });
    pendingPosts[url] = p;
    return p;
  }

  // DOM morphing : patch en place plutôt que remplacement d'innerHTML,
  // pour préserver les transitions CSS et le focus.
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
    if (from.nodeType === 3 && to.nodeType === 3) {
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

  function reloadMain() {
    return fetch(window.location.pathname, { headers: { Accept: 'text/html' } })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var nextMain = doc.querySelector('main');
        var currMain = document.querySelector('main');
        if (nextMain && currMain) patch(currMain, nextMain);
        doc.querySelectorAll('script[type="application/json"]').forEach(function (s) {
          if (!s.id) return;
          var existing = document.getElementById(s.id);
          if (existing && existing.textContent !== s.textContent) existing.textContent = s.textContent;
        });
        window.dispatchEvent(new CustomEvent('admin:reloaded'));
      });
  }

  window.AdminAjax = { postForm: postForm, post: post, reloadMain: reloadMain };
})();
