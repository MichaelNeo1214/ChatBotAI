/**
 * Settings store.
 *
 * One place owns every user preference, so the settings modal, the model
 * picker, the theme toggle and the chat payload all read the same values
 * instead of each keeping their own copy in localStorage.
 *
 * Design notes:
 *   - Every value is validated on the way in AND on the way out of storage, so
 *     a hand-edited or stale localStorage entry can never put the UI into an
 *     impossible state (temperature 9, theme "neon").
 *   - `chatParameters()` returns only fields the user actually set, because the
 *     upstream API omits absent fields so the provider's own defaults apply.
 *   - Writes are debounced-free and synchronous: the payload is assembled at
 *     send time, so there is no race between editing a slider and sending.
 */
(function (global) {
    'use strict';

    var STORAGE_KEY = 'chatbot.settings.v1';

    var THEMES = ['dark', 'light', 'system'];

    /**
     * Models offered in the picker. The first is the server-held default and
     * needs no key; the rest are OpenRouter's :free tier, also served on the
     * server's key. BYOK providers are appended by the app because their labels
     * must stay in sync with the presets the backend knows about.
     */
    var DEFAULT_FREE_MODELS = [
        { label: 'OpenRouter Free', model: 'openrouter/free', note: 'Auto-picks a free model' },
        { label: 'Qwen 3.8 27B', model: 'qwen/qwen3.8-27b:free', note: 'Vision + tools' },
        { label: 'Gemini 2.0 Flash', model: 'google/gemini-2.0-flash-exp:free', note: 'Fast' },
        { label: 'Inkling', model: 'thinkingmachines/inkling:free', note: '1M context' }
    ];

    /** Bounds mirror src/providers/parameters.ts so the UI cannot produce a 400. */
    var LIMITS = {
        temperature: { min: 0, max: 2, step: 0.05, default: null },
        topP: { min: 0.01, max: 1, step: 0.01, default: null },
        maxTokens: { min: 1, max: 64000, step: 256, default: null },
        systemPrompt: { max: 8000, default: '' }
    };

    var DEFAULTS = {
        theme: 'dark',
        model: 'OpenRouter Free',
        systemPrompt: '',
        temperature: null,
        topP: null,
        maxTokens: null,
        sendOnEnter: true,
        autoScroll: true
    };

    function clampNumber(value, spec) {
        if (value === null || value === undefined || value === '') return null;
        var n = typeof value === 'number' ? value : Number(value);
        if (!isFinite(n)) return null;
        if (n < spec.min) return spec.min;
        if (n > spec.max) return spec.max;
        return n;
    }

    /** Coerces an arbitrary object into a valid settings object. */
    function sanitize(raw) {
        var input = (raw && typeof raw === 'object') ? raw : {};
        var out = {};

        out.theme = THEMES.indexOf(input.theme) !== -1 ? input.theme : DEFAULTS.theme;
        out.model = typeof input.model === 'string' && input.model.trim() !== ''
            ? input.model.trim()
            : DEFAULTS.model;

        var prompt = typeof input.systemPrompt === 'string' ? input.systemPrompt : '';
        out.systemPrompt = prompt.length > LIMITS.systemPrompt.max
            ? prompt.slice(0, LIMITS.systemPrompt.max)
            : prompt;

        out.temperature = clampNumber(input.temperature, LIMITS.temperature);
        out.topP = clampNumber(input.topP, LIMITS.topP);

        var maxTokens = clampNumber(input.maxTokens, LIMITS.maxTokens);
        // Whole numbers only, rounded to the slider step so the stored value
        // and the displayed value cannot disagree.
        out.maxTokens = maxTokens === null ? null : Math.round(maxTokens);

        out.sendOnEnter = input.sendOnEnter !== false;
        out.autoScroll = input.autoScroll !== false;

        return out;
    }

    var state = null;
    var listeners = [];
    var storageBroken = false;

    function read() {
        if (state !== null) return state;
        var raw = null;
        try {
            raw = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || 'null');
        } catch (e) {
            // Private mode, disabled storage, or corrupted JSON.
            storageBroken = true;
            raw = null;
        }
        state = sanitize(raw);
        return state;
    }

    function persist() {
        if (storageBroken) return;
        try {
            global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {
            storageBroken = true;
        }
    }

    function emit() {
        for (var i = 0; i < listeners.length; i++) {
            try {
                listeners[i](state);
            } catch (e) {
                console.error('[settings] listener failed', e);
            }
        }
    }

    /** Merges a patch, re-validates, persists and notifies. Returns the state. */
    function set(patch) {
        var next = sanitize(Object.assign({}, read(), patch || {}));
        var changed = JSON.stringify(next) !== JSON.stringify(state);
        state = next;
        persist();
        // Notify even when unchanged so callers can rely on a single call to
        // refresh dependent UI (theme, sliders) after any write.
        emit();
        return { state: state, changed: changed };
    }

    function subscribe(fn) {
        if (typeof fn === 'function') listeners.push(fn);
        return function () {
            listeners = listeners.filter(function (other) { return other !== fn; });
        };
    }

    function reset() {
        state = sanitize({});
        persist();
        emit();
        return state;
    }

    /**
     * The `parameters` block for a chat request.
     *
     * Only fields the user actually set are included: the upstream adapters
     * omit absent fields so the provider's own defaults apply, which matters on
     * the free tier where the routed models disagree about sensible defaults.
     */
    function chatParameters() {
        var s = read();
        var out = {};
        if (s.systemPrompt !== '') out.systemPrompt = s.systemPrompt;
        if (s.temperature !== null) out.temperature = s.temperature;
        if (s.topP !== null) out.topP = s.topP;
        if (s.maxTokens !== null) out.maxTokens = s.maxTokens;
        return out;
    }

    /**
     * Applies the theme to <html>/<body>.
     *
     * 'system' follows the OS via matchMedia and keeps following it while the
     * page is open, so switching the device to dark mode takes effect without
     * a reload.
     */
    var mediaQuery = null;
    function systemPrefersDark() {
        if (!mediaQuery) {
            mediaQuery = typeof global.matchMedia === 'function'
                ? global.matchMedia('(prefers-color-scheme: dark)')
                : null;
        }
        return !!(mediaQuery && mediaQuery.matches);
    }

    function applyTheme() {
        var theme = read().theme;
        var dark = theme === 'dark' || (theme === 'system' && systemPrefersDark());
        var body = global.document && global.document.body;
        if (!body) return dark;

        body.classList.toggle('light', !dark);
        body.classList.toggle('dark', dark);

        var meta = global.document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', dark ? '#171717' : '#ffffff');
        return dark;
    }

    /** Cycles dark -> light -> system, which is what a single toggle button wants. */
    function cycleTheme() {
        var order = ['dark', 'light', 'system'];
        var next = order[(order.indexOf(read().theme) + 1) % order.length];
        set({ theme: next });
        return next;
    }

    function watchSystemTheme() {
        if (!mediaQuery || typeof mediaQuery.addEventListener !== 'function') return;
        mediaQuery.addEventListener('change', function () {
            if (read().theme === 'system') applyTheme();
        });
    }

    global.ChatBotSettings = {
        DEFAULTS: DEFAULTS,
        LIMITS: LIMITS,
        THEMES: THEMES,
        DEFAULT_FREE_MODELS: DEFAULT_FREE_MODELS,
        STORAGE_KEY: STORAGE_KEY,

        get: read,
        set: set,
        subscribe: subscribe,
        reset: reset,
        sanitize: sanitize,
        chatParameters: chatParameters,
        applyTheme: applyTheme,
        cycleTheme: cycleTheme,
        watchSystemTheme: watchSystemTheme,
        isStorageBroken: function () { return storageBroken; }
    };
})(typeof window !== 'undefined' ? window : globalThis);
