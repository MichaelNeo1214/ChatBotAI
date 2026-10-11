/**
 * Toast notifications, the global error boundary, and the server-status banner.
 *
 * Loaded before js/script.js and kept separate from it because these concerns
 * are cross-cutting: the error boundary has to be installed before any other
 * script can throw, and the status check has to run whether or not the chat UI
 * ever initialises.
 *
 * Every message here is written for a human. Raw console errors are logged for
 * debugging but never surfaced, and a thrown string or an Error without a
 * message still produces a readable sentence rather than "undefined".
 */
(function (global) {
    'use strict';

    var MAX_VISIBLE = 4;
    var DEFAULT_DURATION = 5200;
    var RATE_LIMIT_DURATION = 9000;

    var container = null;
    var live = [];

    function ensureContainer() {
        if (container && container.isConnected) return container;
        container = document.createElement('div');
        container.className = 'toast-stack';
        container.setAttribute('role', 'region');
        container.setAttribute('aria-label', 'Notifications');
        document.body.appendChild(container);
        return container;
    }

    function iconFor(type) {
        var paths = {
            success: '<polyline points="20 6 9 17 4 12"/>',
            error: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
            warn: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
            info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'
        };
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            (paths[type] || paths.info) + '</svg>';
    }

    function dismiss(entry) {
        if (entry.closed) return;
        entry.closed = true;
        clearTimeout(entry.timer);
        entry.el.classList.add('toast-leaving');
        var node = entry.el;
        window.setTimeout(function () {
            if (node.parentNode) node.parentNode.removeChild(node);
        }, 220);
        live = live.filter(function (other) { return other !== entry; });
    }

    /**
     * Shows a transient notification.
     *
     * @param {string} message  Human-readable text. Never a raw error object.
     * @param {object} [options]
     * @param {'info'|'success'|'warn'|'error'} [options.type='info']
     * @param {number} [options.duration]  Milliseconds; 0 keeps it until dismissed.
     * @param {{label:string,onClick:function}} [options.action]
     * @returns {{dismiss:function}}
     */
    function toast(message, options) {
        var opts = options || {};
        var text = typeof message === 'string' ? message.trim() : '';
        if (text === '') return { dismiss: function () {} };

        var type = ['info', 'success', 'warn', 'error'].indexOf(opts.type) !== -1
            ? opts.type
            : 'info';
        var duration = typeof opts.duration === 'number' ? opts.duration : DEFAULT_DURATION;

        // Anything beyond MAX_VISIBLE is the oldest toast; drop it rather than
        // letting a burst of failures bury the composer.
        while (live.length >= MAX_VISIBLE) dismiss(live[0]);

        var el = document.createElement('div');
        el.className = 'toast toast-' + type;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');
        el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');

        // textContent, never innerHTML: a vendor error string can contain
        // anything, and this is the one place untrusted text enters the DOM
        // outside the sanitized markdown pipeline.
        var icon = document.createElement('span');
        icon.className = 'toast-icon';
        icon.innerHTML = iconFor(type);

        var body = document.createElement('span');
        body.className = 'toast-message';
        body.textContent = text;

        el.appendChild(icon);
        el.appendChild(body);

        var entry = { el: el, timer: null, closed: false };

        if (opts.action && typeof opts.action.onClick === 'function') {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'toast-action';
            btn.textContent = opts.action.label || 'Retry';
            btn.addEventListener('click', function () {
                dismiss(entry);
                opts.action.onClick();
            });
            el.appendChild(btn);
        }

        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'toast-close';
        closeBtn.setAttribute('aria-label', 'Dismiss notification');
        closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        closeBtn.addEventListener('click', function () { dismiss(entry); });
        el.appendChild(closeBtn);

        ensureContainer().appendChild(el);
        live.push(entry);

        // Re-trigger the entrance transition on the next frame.
        global.requestAnimationFrame(function () {
            el.classList.add('toast-visible');
        });

        if (duration > 0) {
            entry.timer = global.setTimeout(function () { dismiss(entry); }, duration);
        }
        return { dismiss: function () { dismiss(entry); } };
    }

    /** Turns any thrown value into something worth showing a person. */
    function describe(error, fallback) {
        if (typeof error === 'string' && error.trim() !== '') return error.trim();
        if (error && typeof error.message === 'string' && error.message.trim() !== '') {
            return error.message.trim();
        }
        return fallback;
    }

    /**
     * Catches anything that escapes a handler.
     *
     * Script errors are logged for the console and reported as a toast; the
     * default is suppressed so a single bad handler cannot leave the user
     * staring at a frozen composer with no explanation.
     */
    function installErrorBoundary() {
        global.addEventListener('error', function (event) {
            // Resource load failures (an <img> or a <script> that 404d) are not
            // script errors and must not be reported as one.
            if (event.target && event.target !== global) return;

            console.error('[uncaught]', event.error || event.message);
            toast('Something went wrong on this page. ' +
                describe(event.error, 'Please try again.'), { type: 'error' });
        });

        global.addEventListener('unhandledrejection', function (event) {
            const reason = event.reason;
            // A turn the user cancelled is an expected rejection, not a fault.
            if (reason && reason.name === 'AbortError') return;

            console.error('[unhandled rejection]', reason);
            toast('A background task failed. ' + describe(reason, 'Please try again.'), {
                type: 'error'
            });
        });
    }

    /** A rate-limit notice that says when to come back, not just that it failed. */
    function rateLimited(retryAfterSeconds) {
        var seconds = typeof retryAfterSeconds === 'number' && isFinite(retryAfterSeconds)
            ? Math.ceil(retryAfterSeconds)
            : null;
        var message = seconds && seconds > 0
            ? 'You have reached the message limit for this minute. Try again in ' +
              seconds + (seconds === 1 ? ' second.' : ' seconds.')
            : 'You have reached the message limit. Please wait a moment and try again.';
        return toast(message, { type: 'warn', duration: RATE_LIMIT_DURATION });
    }

    /**
     * Reads /api/health and reports whether replies are real.
     *
     * A deployment with no AI_API_KEY serves the mock provider. That is useful
     * for local development and useless to a visitor, so it is surfaced as a
     * persistent banner rather than passed off as a working free tier.
     */
    function checkServerStatus() {
        if (!global.fetch) return Promise.resolve(null);

        return global.fetch('/api/health', { headers: { Accept: 'application/json' } })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (info) {
                if (!info || info.demo !== true) return info;
                renderDemoBanner(info);
                return info;
            })
            .catch(function () {
                // Offline or the function is still cold-starting. Not worth a
                // toast — the composer already reports a failed turn.
                return null;
            });
    }

    function renderDemoBanner(info) {
        if (document.querySelector('.demo-banner')) return;

        var banner = document.createElement('div');
        banner.className = 'demo-banner';
        banner.setAttribute('role', 'status');

        var text = document.createElement('span');
        text.className = 'demo-banner-text';
        text.textContent = 'Demo mode — this server has no AI key configured, so replies are canned. ' +
            'Set AI_API_KEY on the deployment to enable ' +
            (info && info.defaultModel ? info.defaultModel : 'the free model') + '.';
        banner.appendChild(text);

        var dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'demo-banner-close';
        dismissBtn.setAttribute('aria-label', 'Dismiss');
        dismissBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        dismissBtn.addEventListener('click', function () { banner.remove(); });
        banner.appendChild(dismissBtn);

        var host = document.getElementById('chatArea') || document.body;
        host.insertBefore(banner, host.firstChild);
    }

    global.ChatBotUI = {
        toast: toast,
        describe: describe,
        installErrorBoundary: installErrorBoundary,
        rateLimited: rateLimited,
        checkServerStatus: checkServerStatus
    };

    // Installed immediately: this script loads before the chat UI, so it is the
    // earliest point at which a stray error can be caught.
    installErrorBoundary();
})(window);