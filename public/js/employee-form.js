// Submit AJAX pour les formulaires employé (#main-form sur frais, absences,
// pannes, rapatriements). Remplace le POST/redirect classique par :
//  - validation HTML5 native (required, min, max…) avant l'envoi
//  - fetch JSON vers form.action
//  - toast succès + reset du form si {ok:true}
//  - toast erreur si {error:'...'} (sans reset, l'utilisateur peut corriger)
//
// Le serveur doit répondre en JSON. Status 4xx/5xx → toast erreur.

(function () {
  var SPINNER = '<i class="fa-solid fa-spinner fa-spin"></i>';

  function getOrCreateErrorToast() {
    var t = document.getElementById('toast-error');
    if (t) return t;
    t = document.createElement('div');
    t.id = 'toast-error';
    t.className = 'toast error';
    t.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i><span id="toast-error-msg"></span>';
    document.body.appendChild(t);
    return t;
  }

  function showSuccess(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    var span = document.getElementById('toast-msg');
    if (span && msg) span.textContent = msg;
    t.className = 'toast success show';
    setTimeout(function () { t.classList.remove('show'); }, 3500);
  }

  function showError(msg) {
    var t = getOrCreateErrorToast();
    document.getElementById('toast-error-msg').textContent = msg || 'Erreur lors de l’envoi';
    t.className = 'toast error show';
    setTimeout(function () { t.classList.remove('show'); }, 4500);
  }

  function lockSubmit(form) {
    var btns = form.querySelectorAll('button[type="submit"]');
    var orig = [];
    btns.forEach(function (b, i) {
      orig[i] = b.innerHTML;
      b.innerHTML = SPINNER;
      b.disabled = true;
    });
    return function unlock() {
      btns.forEach(function (b, i) {
        b.innerHTML = orig[i];
        b.disabled = false;
      });
    };
  }

  document.addEventListener('DOMContentLoaded', function () {
    var form = document.getElementById('main-form');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      // Validation HTML5 native (required, min, max, type=number…). Le navigateur
      // affiche le tooltip standard sur le premier champ invalide.
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      if (form.dataset._busy === '1') return;
      form.dataset._busy = '1';
      var unlock = lockSubmit(form);

      var body = new URLSearchParams(new FormData(form));
      fetch(form.action, {
        method: 'POST',
        body: body,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
      })
        .then(function (r) {
          return r.json().then(function (data) { return { ok: r.ok, data: data }; })
            .catch(function () { return { ok: r.ok, data: { error: 'Réponse serveur invalide' } }; });
        })
        .then(function (res) {
          if (res.ok && res.data && res.data.ok) {
            form.reset();
            showSuccess(res.data.message || 'Formulaire envoyé avec succès');
          } else {
            showError((res.data && res.data.error) || 'Erreur lors de l’envoi');
          }
        })
        .catch(function (err) {
          showError(err && err.message ? err.message : 'Erreur réseau');
        })
        .finally(function () {
          unlock();
          delete form.dataset._busy;
        });
    });
  });
})();
