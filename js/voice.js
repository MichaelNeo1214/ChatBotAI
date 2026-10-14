/**
 * Read-aloud for assistant replies, using the browser's built-in speech
 * synthesiser.
 *
 * Why the Web Speech API rather than a model vendor's audio endpoint: it needs
 * no API key, costs nothing, works on every platform, and degrades to silence
 * rather than to an error when a device has no voices installed. The Voice
 * settings panel previously offered invented names ("Ember", "Sky") and a
 * playback speed for a feature that did not exist; this makes both controls
 * real by listing the voices the device actually has.
 */
(function (global) {
    'use strict';

    if (!global.document) return;

    var synth = global.speechSynthesis || null;
    var settings = global.ChatBotSettings || null;

    var state = {
        supported: !!synth && typeof global.SpeechSynthesisUtterance === 'function',
        voices: [],
        current: null
    };

    function notify() {
        try {
            global.dispatchEvent(new CustomEvent('chatbot:voices', { detail: state.voices }));
        } catch (e) { /* no CustomEvent in this environment */ }
    }

    /** Voices often arrive asynchronously, so the list is refreshed on demand. */
    function refreshVoices() {
        if (!state.supported) return [];
        try {
            var list = synth.getVoices() || [];
            // Prefer English voices: the UI, and the model's output, are English.
            list.sort(function (a, b) {
                var ae = /^en/i.test(a.lang || '') ? 0 : 1;
                var be = /^en/i.test(b.lang || '') ? 0 : 1;
                if (ae !== be) return ae - be;
                return String(a.name).localeCompare(String(b.name));
            });
            state.voices = list;
        } catch (e) {
            state.voices = [];
        }
        notify();
        return state.voices;
    }

    function stop() {
        if (!state.supported) return;
        try {
            synth.cancel();
        } catch (e) { /* nothing queued */ }
        state.current = null;
        paint();
    }

    /** Resolves the configured voice name to a real voice, if it still exists. */
    function resolveVoice() {
        var name = settings ? settings.get('ttsVoice') : '';
        if (!name) return null;
        var voices = state.voices.length ? state.voices : refreshVoices();
        for (var i = 0; i < voices.length; i++) {
            if (voices[i] && voices[i].name === name) return voices[i];
        }
        return null;
    }

    function speechText(text) {
        return String(text == null ? '' : text)
            // Inline code markers and fenced fences read badly aloud.
            .replace(/```[\s\S]*?```/g, ' code block ')
            .replace(/```/g, ' ')
            .replace(/`([^`]+)`/g, '$1')
            // Headings, emphasis and list bullets are visual, not phonetic.
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/^\s*>\s?/gm, '')
            .replace(/^\s*[-*+]\s+/gm, '')
            .replace(/^\s*\d+\.\s+/gm, '')
            .replace(/(\*\*|__|\*|_)/g, '')
            .replace(/\|/g, ' ')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function speak(text, onEnd) {
        if (!state.supported) return false;
        var spoken = speechText(text);
        if (spoken === '') return false;

        try {
            // Chrome queues rather than replacing, so a second click would play
            // after the first. Cancelling first makes the button a toggle.
            synth.cancel();
            var u = new global.SpeechSynthesisUtterance(spoken);
            var voice = resolveVoice();
            if (voice) u.voice = voice;
            var rate = settings ? settings.get('ttsRate') : 1;
            u.rate = (typeof rate === 'number' && isFinite(rate)) ? rate : 1;
            u.lang = voice && voice.lang ? voice.lang : 'en-US';
            u.onend = function () { state.current = null; paint(); if (onEnd) onEnd(); };
            u.onerror = function () { state.current = null; paint(); if (onEnd) onEnd(); };
            state.current = spoken;
            synth.speak(u);
            paint();
            return true;
        } catch (e) {
            state.current = null;
            paint();
            return false;
        }
    }

    var paint = (function () {
        var queued = null;
        return function () {
            // Batched so a rapid toggle() cannot interleave DOM writes.
            if (queued) return;
            queued = global.requestAnimationFrame(function () {
                queued = null;
                var nodes = global.document.querySelectorAll('[data-tts-toggle]');
                for (var i = 0; i < nodes.length; i++) {
                    var btn = nodes[i];
                    var target = btn.getAttribute('data-tts-text') || '';
                    var speaking = state.current !== null && state.current === speechText(target);
                    btn.classList.toggle('is-speaking', speaking);
                    btn.setAttribute('aria-pressed', speaking ? 'true' : 'false');
                    btn.setAttribute('aria-label', speaking ? 'Stop reading aloud' : 'Read aloud');
                }
            });
        };
    })();

    /** Wire a button so it toggles playback for its own message. */
    function attach(button) {
        if (!button || button.dataset.ttsWired === 'true') return;
        var text = button.getAttribute('data-tts-text') || '';
        button.dataset.ttsWired = 'true';
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', function () {
            var label = speechText(button.getAttribute('data-tts-text') || '');
            if (state.current !== null && state.current === label) {
                stop();
            } else {
                speak(button.getAttribute('data-tts-text') || '');
            }
        });
    }

    function init() {
        if (!state.supported) {
            var panel = global.document.querySelector('[data-panel="voice"]');
            if (panel) {
                var note = global.document.createElement('div');
                note.className = 'setting-desc';
                note.textContent = 'This browser has no speech synthesiser, so read-aloud is unavailable.';
                panel.appendChild(note);
            }
            return;
        }

        refreshVoices();
        // getVoices() is empty until the engine loads; this event fires later.
        if (typeof synth.addEventListener === 'function') {
            synth.addEventListener('voiceschanged', refreshVoices);
        } else {
            synth.onvoiceschanged = refreshVoices;
        }

        var voiceSelect = global.document.getElementById('voiceSelect');
        if (voiceSelect) {
            voiceSelect.innerHTML = '';
            var auto = global.document.createElement('option');
            auto.value = '';
            auto.textContent = 'Automatic';
            voiceSelect.appendChild(auto);
            var list = state.voices.length ? state.voices : refreshVoices();
            for (var i = 0; i < list.length; i++) {
                var v = list[i];
                var opt = global.document.createElement('option');
                opt.value = v.name;
                opt.textContent = v.name + ' (' + (v.lang || 'unknown') + ')';
                voiceSelect.appendChild(opt);
            }
            var saved = settings ? settings.get('ttsVoice') : '';
            voiceSelect.value = saved || '';
            voiceSelect.addEventListener('change', function () {
                if (settings) settings.set({ ttsVoice: voiceSelect.value });
            });
        }

        var speedSelect = global.document.getElementById('speedSelect');
        if (speedSelect) {
            var rate = settings ? settings.get('ttsRate') : 1;
            speedSelect.value = String(typeof rate === 'number' ? rate : 1);
            speedSelect.addEventListener('change', function () {
                if (settings) settings.set({ ttsRate: Number(speedSelect.value) });
            });
        }
    }

    global.ChatBotVoice = {
        supported: state.supported,
        refreshVoices: refreshVoices,
        voices: function () { return state.voices; },
        speak: speak,
        stop: stop,
        attach: attach,
        isSpeaking: function () { return state.current !== null; },
        speechText: speechText,
        init: init
    };

    if (global.document.readyState === 'loading') {
        global.document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(typeof window !== 'undefined' ? window : this);