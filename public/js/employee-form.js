// Submit AJAX pour les formulaires employé (#main-form sur frais, absences,
// pannes, rapatriements). Remplace le POST/redirect classique par :
//  - validation HTML5 native (required, min, max…) avant l'envoi
//  - fetch JSON vers form.action
//  - toast succès + reset du form si {ok:true}
//  - toast erreur si {error:'...'} (sans reset, l'utilisateur peut corriger)
//
// Le serveur doit répondre en JSON. Status 4xx/5xx → toast erreur.
// Les toasts passent par window.showToast (helper centralisé toast.js).

(function () {
  var SPINNER = '<i class="fa-solid fa-spinner fa-spin"></i>';

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
            window.showToast(res.data.message || 'Formulaire envoyé avec succès', 'success');
          } else {
            window.showToast((res.data && res.data.error) || 'Erreur lors de l’envoi', 'error');
          }
        })
        .catch(function (err) {
          window.showToast(err && err.message ? err.message : 'Erreur réseau', 'error');
        })
        .finally(function () {
          unlock();
          delete form.dataset._busy;
        });
    });
  });
})();
