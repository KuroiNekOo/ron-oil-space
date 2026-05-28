/* Toast de notification centralisé — empilable.
 *
 * API exposée :
 *   window.showToast(msg, type)
 *     - msg  : texte à afficher
 *     - type : 'success' (défaut) | 'error' | 'warning' | 'info'
 *
 * Plusieurs toasts simultanés sont supportés : chaque appel ajoute un
 * nouveau toast en bas du stack (haut-droite), avec son propre timer.
 * Anciens et nouveaux coexistent jusqu'à l'expiration de leur durée.
 *
 * Le markup #toast-stack (container) est auto-injecté dans <body>.
 * Les vues n'ont rien à déclarer. CSS .toast / .toast-stack vit dans
 * shared.css / admin-shared.css.
 *
 * Durée : 4500 ms pour error, 3500 ms sinon.
 */
(function() {
    'use strict';

    var ICONS = {
        success: 'fa-circle-check',
        error:   'fa-circle-exclamation',
        warning: 'fa-triangle-exclamation',
        info:    'fa-circle-info',
    };

    var stackEl = null;

    function ensureStack() {
        if (stackEl && document.body.contains(stackEl)) return stackEl;
        stackEl = document.getElementById('toast-stack');
        if (stackEl) return stackEl;
        stackEl = document.createElement('div');
        stackEl.id = 'toast-stack';
        stackEl.className = 'toast-stack';
        document.body.appendChild(stackEl);
        return stackEl;
    }

    function escapeText(s) {
        // textContent suffit (pas d'innerHTML), donc pas besoin d'échapper —
        // on convertit juste en string et on gère null/undefined.
        return s == null ? '' : String(s);
    }

    function removeToast(el) {
        // Anim out : on retire .show pour rejouer la transition inverse, puis
        // on supprime du DOM une fois la transition terminée.
        if (!el || !el.parentNode) return;
        el.classList.remove('show');
        // Si la transition ne se déclenche pas (toast déjà invisible), nettoie
        // quand même au bout de la durée nominale.
        var done = false;
        var cleanup = function() {
            if (done) return;
            done = true;
            if (el.parentNode) el.parentNode.removeChild(el);
        };
        el.addEventListener('transitionend', cleanup, { once: true });
        setTimeout(cleanup, 400);
    }

    function showToast(msg, type) {
        type = type && ICONS[type] ? type : 'success';
        var stack = ensureStack();
        var toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.innerHTML = '<i class="fa-solid ' + ICONS[type] + '"></i><span class="toast-msg"></span>';
        toast.querySelector('.toast-msg').textContent = escapeText(msg);
        stack.appendChild(toast);
        // Force un reflow pour que la transition .show parte de l'état initial
        // (sinon le toast apparaît brutalement, sans anim slide-in).
        void toast.offsetWidth;
        toast.classList.add('show');
        var duration = type === 'error' ? 4500 : 3500;
        setTimeout(function() { removeToast(toast); }, duration);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureStack);
    } else {
        ensureStack();
    }

    window.showToast = showToast;
})();
