/* Toast de notification centralisé — remplace les markups + fonctions
 * showToast() dupliqués dans toutes les vues.
 *
 * API exposée :
 *   window.showToast(msg, type)
 *     - msg  : texte à afficher
 *     - type : 'success' (défaut) | 'error' | 'warning' | 'info'
 *
 * Un seul toast à la fois (singleton). Le timer redémarre à chaque appel,
 * donc un nouveau toast remplace immédiatement le précédent. Durée :
 * 4500 ms pour error, 3500 ms sinon.
 *
 * Le markup #toast / #toast-msg est auto-injecté dans <body>. Les vues
 * n'ont donc plus besoin de le déclarer. Le CSS .toast vit dans
 * shared.css / admin-shared.css (déjà partagé).
 */
(function() {
    'use strict';

    var ICONS = {
        success: 'fa-circle-check',
        error:   'fa-circle-exclamation',
        warning: 'fa-triangle-exclamation',
        info:    'fa-circle-info',
    };

    var hideTimer = null;

    function ensureDom() {
        var t = document.getElementById('toast');
        if (t) return t;
        t = document.createElement('div');
        t.id = 'toast';
        t.className = 'toast success';
        t.innerHTML = '<i class="fa-solid fa-circle-check"></i><span id="toast-msg"></span>';
        document.body.appendChild(t);
        return t;
    }

    function showToast(msg, type) {
        type = type && ICONS[type] ? type : 'success';
        var t = ensureDom();
        var icon = t.querySelector('i');
        var span = t.querySelector('#toast-msg');
        if (icon) icon.className = 'fa-solid ' + ICONS[type];
        if (span) span.textContent = msg || '';
        // Reset propre pour ré-déclencher l'anim si déjà visible : on retire
        // .show, force un reflow, puis ré-ajoute la classe avec la couleur cible.
        t.classList.remove('show');
        void t.offsetWidth;
        t.className = 'toast ' + type + ' show';
        clearTimeout(hideTimer);
        var duration = type === 'error' ? 4500 : 3500;
        hideTimer = setTimeout(function() { t.classList.remove('show'); }, duration);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureDom);
    } else {
        ensureDom();
    }

    window.showToast = showToast;
})();
