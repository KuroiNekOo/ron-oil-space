/* Modal de confirmation centralisée — remplace les confirm() natifs.
 *
 * Auto-injecte une modal unique dans le <body> et un bloc <style> dans le <head>
 * au chargement de la page. Expose :
 *
 *   window.showConfirm({
 *     title,        // libellé du header (défaut "Confirmation")
 *     message,      // texte du corps (sauts de ligne \n\n → paragraphes, \n → <br>)
 *     html,         // si true, message est interprété comme HTML brut
 *     icon,         // classe Font Awesome (défaut selon variant)
 *     variant,      // 'danger' | 'warning' | 'info'  (défaut 'info')
 *     confirmText,  // libellé bouton primaire (défaut selon variant)
 *     cancelText,   // libellé bouton secondaire (défaut "Annuler")
 *   }) => Promise<boolean>
 *
 * - Touche Escape ou clic backdrop → résout à false.
 * - Touche Enter → résout à true.
 * - Pas de stacking : ouvrir une modal pendant qu'une autre est ouverte
 *   annule la première (resolve(false)).
 */
(function() {
    'use strict';

    var STYLES = [
        '.app-confirm-overlay {',
        '  position: fixed; inset: 0; background: rgba(0,0,0,0.65);',
        '  display: none; align-items: center; justify-content: center;',
        '  z-index: 10000; padding: 20px;',
        '  opacity: 0; transition: opacity .15s ease;',
        '}',
        '.app-confirm-overlay.open { display: flex; opacity: 1; }',
        '.app-confirm-modal {',
        '  background: var(--bg-card, #1A1A23);',
        '  border: 1px solid var(--border, rgba(255,255,255,0.09));',
        '  color: var(--text-primary, #F0EDE8);',
        '  width: 480px; max-width: 92vw;',
        '  display: flex; flex-direction: column;',
        '  font-family: var(--font-body, system-ui, sans-serif);',
        '  transform: translateY(-8px) scale(.98);',
        '  transition: transform .18s ease;',
        '  box-shadow: 0 20px 60px rgba(0,0,0,.45);',
        '}',
        '.app-confirm-overlay.open .app-confirm-modal { transform: none; }',
        '.app-confirm-header {',
        '  display: flex; align-items: center; justify-content: space-between;',
        '  padding: 14px 18px;',
        '  border-bottom: 1px solid var(--border, rgba(255,255,255,0.09));',
        '}',
        '.app-confirm-title { font-size: 14.5px; font-weight: 600; letter-spacing: .02em; }',
        '.app-confirm-title i { margin-right: 8px; }',
        '.app-confirm-close {',
        '  background: none; border: 0; color: var(--text-muted, #908FA6);',
        '  cursor: pointer; font-size: 16px; line-height: 1; padding: 4px 6px;',
        '}',
        '.app-confirm-close:hover { color: var(--text-primary, #F0EDE8); }',
        '.app-confirm-body { padding: 22px 24px 18px; text-align: center; }',
        '.app-confirm-icon { font-size: 42px; margin-bottom: 14px; line-height: 1; }',
        '.app-confirm-message { font-size: 13.5px; line-height: 1.55; color: var(--text-primary, #F0EDE8); }',
        '.app-confirm-message p { margin: 0 0 10px; }',
        '.app-confirm-message p:last-child { margin-bottom: 0; }',
        '.app-confirm-message strong { color: var(--accent, #FF5422); font-weight: 600; }',
        '.app-confirm-footer {',
        '  display: flex; justify-content: flex-end; gap: 10px;',
        '  padding: 13px 16px;',
        '  border-top: 1px solid var(--border, rgba(255,255,255,0.09));',
        '}',
        '.app-confirm-btn {',
        '  display: inline-flex; align-items: center; gap: 7px;',
        '  padding: 9px 16px; font-size: 12.5px; font-weight: 600;',
        '  border: 1px solid transparent; cursor: pointer;',
        '  font-family: inherit; letter-spacing: .02em;',
        '  transition: background .15s, border-color .15s, color .15s;',
        '}',
        '.app-confirm-btn-secondary {',
        '  background: transparent; color: var(--text-secondary, #B5B3C6);',
        '  border-color: var(--border, rgba(255,255,255,0.09));',
        '}',
        '.app-confirm-btn-secondary:hover {',
        '  background: rgba(255,255,255,0.04); color: var(--text-primary, #F0EDE8);',
        '}',
        '.app-confirm-btn-primary {',
        '  background: var(--accent, #FF5422); color: #fff;',
        '  border-color: var(--accent, #FF5422);',
        '}',
        '.app-confirm-btn-primary:hover { background: var(--accent-hover, #FF6D3F); }',
        '/* Variant danger (rouge) — suppressions */',
        '.app-confirm-modal.is-danger .app-confirm-icon { color: var(--danger, #FF4D4D); }',
        '.app-confirm-modal.is-danger .app-confirm-title i { color: var(--danger, #FF4D4D); }',
        '.app-confirm-modal.is-danger .app-confirm-message strong { color: var(--danger, #FF4D4D); }',
        '.app-confirm-modal.is-danger .app-confirm-btn-primary {',
        '  background: var(--danger, #FF4D4D); border-color: var(--danger, #FF4D4D);',
        '}',
        '.app-confirm-modal.is-danger .app-confirm-btn-primary:hover {',
        '  background: #ff6363; border-color: #ff6363;',
        '}',
        '/* Variant warning (orange) — alertes */',
        '.app-confirm-modal.is-warning .app-confirm-icon { color: var(--warning, #F5A623); }',
        '.app-confirm-modal.is-warning .app-confirm-title i { color: var(--warning, #F5A623); }',
        '.app-confirm-modal.is-warning .app-confirm-message strong { color: var(--warning, #F5A623); }',
        '.app-confirm-modal.is-warning .app-confirm-btn-primary {',
        '  background: var(--warning, #F5A623); border-color: var(--warning, #F5A623); color: #1A1A23;',
        '}',
        '.app-confirm-modal.is-warning .app-confirm-btn-primary:hover {',
        '  background: #ffb840; border-color: #ffb840;',
        '}',
        '/* Variant info (accent) — info / régen */',
        '.app-confirm-modal.is-info .app-confirm-icon { color: var(--accent, #FF5422); }',
        '.app-confirm-modal.is-info .app-confirm-title i { color: var(--accent, #FF5422); }',
        '.app-confirm-hint { font-size: 12px; color: var(--text-muted, #908FA6); }',
    ].join('\n');

    // Defaults par variant : icône + libellés des deux boutons. Surchargeable
    // option par option dans l'appel.
    var DEFAULTS = {
        danger:  { icon: 'fa-trash',                confirmText: 'Supprimer', cancelText: 'Annuler' },
        warning: { icon: 'fa-triangle-exclamation', confirmText: 'Continuer', cancelText: 'Annuler' },
        info:    { icon: 'fa-circle-info',          confirmText: 'Confirmer', cancelText: 'Annuler' },
    };

    var state = { overlay: null, modal: null, currentResolver: null, prevOverflow: '' };

    function injectStyles() {
        if (document.getElementById('app-confirm-styles')) return;
        var s = document.createElement('style');
        s.id = 'app-confirm-styles';
        s.textContent = STYLES;
        document.head.appendChild(s);
    }

    function buildDom() {
        if (state.overlay) return;
        var overlay = document.createElement('div');
        overlay.className = 'app-confirm-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.innerHTML = [
            '<div class="app-confirm-modal">',
                '<div class="app-confirm-header">',
                    '<div class="app-confirm-title"></div>',
                    '<button type="button" class="app-confirm-close" aria-label="Fermer">&#10005;</button>',
                '</div>',
                '<div class="app-confirm-body">',
                    '<div class="app-confirm-icon"><i class="fa-solid"></i></div>',
                    '<div class="app-confirm-message"></div>',
                '</div>',
                '<div class="app-confirm-footer">',
                    '<button type="button" class="app-confirm-btn app-confirm-btn-secondary"></button>',
                    '<button type="button" class="app-confirm-btn app-confirm-btn-primary"></button>',
                '</div>',
            '</div>',
        ].join('');
        document.body.appendChild(overlay);
        state.overlay = overlay;
        state.modal = overlay.querySelector('.app-confirm-modal');

        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) resolve(false);
        });
        overlay.querySelector('.app-confirm-close').addEventListener('click', function() { resolve(false); });
        overlay.querySelector('.app-confirm-btn-secondary').addEventListener('click', function() { resolve(false); });
        overlay.querySelector('.app-confirm-btn-primary').addEventListener('click', function() { resolve(true); });
        document.addEventListener('keydown', function(e) {
            if (!state.currentResolver) return;
            if (e.key === 'Escape') { e.preventDefault(); resolve(false); }
            else if (e.key === 'Enter') { e.preventDefault(); resolve(true); }
        });
    }

    function resolve(result) {
        if (!state.currentResolver) return;
        var r = state.currentResolver;
        state.currentResolver = null;
        state.overlay.classList.remove('open');
        document.body.style.overflow = state.prevOverflow;
        r(result);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function(c) {
            return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c];
        });
    }

    // Convertit un texte brut en HTML : \n\n → paragraphes, \n simple → <br>.
    // Préserve l'esprit des anciens confirm() multi-lignes.
    function messageToHtml(msg, useHtml) {
        if (useHtml) return msg;
        return String(msg).split(/\n{2,}/).map(function(block) {
            return '<p>' + escapeHtml(block).replace(/\n/g, '<br>') + '</p>';
        }).join('');
    }

    function showConfirm(opts) {
        if (!opts) opts = {};
        if (typeof opts === 'string') opts = { message: opts };
        injectStyles();
        buildDom();

        // Pas de stacking : annule la modal courante avant d'ouvrir la nouvelle.
        if (state.currentResolver) resolve(false);

        var variant = DEFAULTS[opts.variant] ? opts.variant : 'info';
        var def = DEFAULTS[variant];
        var icon = opts.icon || def.icon;

        state.modal.className = 'app-confirm-modal is-' + variant;
        state.modal.querySelector('.app-confirm-title').innerHTML =
            '<i class="fa-solid ' + icon + '"></i>' + escapeHtml(opts.title || 'Confirmation');
        state.modal.querySelector('.app-confirm-icon i').className = 'fa-solid ' + icon;
        state.modal.querySelector('.app-confirm-message').innerHTML =
            messageToHtml(opts.message || '', !!opts.html);
        state.modal.querySelector('.app-confirm-btn-secondary').textContent =
            opts.cancelText || def.cancelText;
        var primaryBtn = state.modal.querySelector('.app-confirm-btn-primary');
        primaryBtn.innerHTML =
            '<i class="fa-solid ' + icon + '"></i> ' + escapeHtml(opts.confirmText || def.confirmText);

        state.prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        state.overlay.classList.add('open');
        setTimeout(function() { primaryBtn.focus(); }, 30);

        return new Promise(function(res) { state.currentResolver = res; });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { injectStyles(); buildDom(); });
    } else {
        injectStyles();
        buildDom();
    }

    window.showConfirm = showConfirm;
})();
