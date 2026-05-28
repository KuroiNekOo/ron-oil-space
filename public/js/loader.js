/* Overlay de chargement centralisé — affiche un spinner sur fond assombri
 * pendant les requêtes asynchrones longues.
 *
 * API exposée :
 *   window.showLoader()              → incrémente le refcount ; affiche l'overlay
 *                                       après 200 ms si toujours actif (anti-flash).
 *   window.hideLoader()              → décrémente le refcount ; masque dès qu'il atteint 0.
 *   window.withLoader(promiseOrFn)   → wrappe une promise (ou une fonction qui en renvoie une)
 *                                       avec show/hide automatiques. Renvoie la promise telle quelle.
 *
 * Le refcount permet d'empiler plusieurs requêtes simultanées sans clignotement :
 * l'overlay reste affiché tant qu'au moins une opération est en vol.
 *
 * Le délai 200 ms évite le flash sur les requêtes rapides : si la promise se
 * résout avant ce délai, l'overlay n'est jamais affiché.
 */
(function() {
    'use strict';

    var STYLES = [
        '.app-loader-overlay {',
        '  position: fixed; inset: 0;',
        '  background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(2px);',
        '  display: none; align-items: center; justify-content: center;',
        '  z-index: 10500;',
        '  opacity: 0; transition: opacity .15s ease;',
        '  pointer-events: all;',
        '}',
        '.app-loader-overlay.visible { display: flex; opacity: 1; }',
        '.app-loader-spinner {',
        '  width: 56px; height: 56px;',
        '  border: 4px solid rgba(255, 255, 255, 0.12);',
        '  border-top-color: var(--accent, #FF5422);',
        '  border-radius: 50%;',
        '  animation: appLoaderSpin .8s linear infinite;',
        '}',
        '@keyframes appLoaderSpin {',
        '  to { transform: rotate(360deg); }',
        '}',
    ].join('\n');

    var SHOW_DELAY_MS = 200;
    var state = { count: 0, overlay: null, showTimer: null };

    function injectStyles() {
        if (document.getElementById('app-loader-styles')) return;
        var s = document.createElement('style');
        s.id = 'app-loader-styles';
        s.textContent = STYLES;
        document.head.appendChild(s);
    }

    function buildDom() {
        if (state.overlay) return;
        var overlay = document.createElement('div');
        overlay.className = 'app-loader-overlay';
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('aria-live', 'polite');
        overlay.setAttribute('aria-label', 'Chargement en cours');
        overlay.innerHTML = '<div class="app-loader-spinner"></div>';
        document.body.appendChild(overlay);
        state.overlay = overlay;
    }

    function actuallyShow() {
        state.showTimer = null;
        if (state.count <= 0) return;
        if (!state.overlay) buildDom();
        state.overlay.classList.add('visible');
    }

    function showLoader() {
        state.count++;
        if (state.count === 1 && !state.overlay) buildDom();
        // Délai anti-flash : si la promise est rapide (< 200 ms), l'overlay
        // n'est jamais affiché. Sinon il apparaît après le délai.
        if (state.count === 1 && !state.showTimer) {
            state.showTimer = setTimeout(actuallyShow, SHOW_DELAY_MS);
        }
    }

    function hideLoader() {
        if (state.count > 0) state.count--;
        if (state.count > 0) return;
        if (state.showTimer) {
            clearTimeout(state.showTimer);
            state.showTimer = null;
        }
        if (state.overlay) state.overlay.classList.remove('visible');
    }

    // Wrapper utilitaire : `withLoader(fetch(...))` ou `withLoader(() => fetch(...))`.
    // Garantit que hideLoader est appelé même si la promise rejette.
    function withLoader(promiseOrFn) {
        var p = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
        showLoader();
        // Promise.resolve permet d'accepter aussi des thenables / valeurs synchrones.
        return Promise.resolve(p).finally(hideLoader);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { injectStyles(); buildDom(); });
    } else {
        injectStyles();
        buildDom();
    }

    window.showLoader = showLoader;
    window.hideLoader = hideLoader;
    window.withLoader = withLoader;
})();
