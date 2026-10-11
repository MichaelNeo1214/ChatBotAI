/**
 * Conversation titles.
 *
 * The original behaviour took the first user message and cut it at 60
 * characters, which produces exactly the sidebar junk this replaces: "te",
 * "yt", "ok". A title has to be a *label*, not a prefix of what was typed.
 *
 * Two paths, in priority order:
 *
 *   1. `aiTitle` asks the model for a 3-6 word summary. Cheap and good, but it
 *      costs a request, so it is skipped when the title already exists or the
 *      app is offline.
 *   2. `keywordTitle` derives a label locally from the words themselves. Free,
 *      instant, and never fails — which is why it is the fallback rather than
 *      an error path.
 *
 * Both are pure functions over text so the rules can be unit tested without a
 * browser, a network, or a model.
 */
(function (global) {
    'use strict';

    var MIN_WORDS = 2;
    var MAX_WORDS = 6;
    var MAX_CHARS = 48;

    /**
     * Words too common to identify a conversation. Kept deliberately short:
     * this list is for "is this word worth showing in a sidebar", not for
     * search, and every entry here costs a title its most distinctive word.
     */
    var STOP_WORDS = new Set([
        'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'so',
        'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into',
        'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
        'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having',
        'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'you', 'your', 'yours',
        'he', 'she', 'it', 'they', 'them', 'their', 'this', 'that', 'these', 'those',
        'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
        'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
        'please', 'help', 'hi', 'hello', 'hey', 'thanks', 'thank', 'ok', 'okay',
        'yes', 'no', 'yep', 'nope', 'sure', 'just', 'very', 'really', 'also',
        'not', 'no', 'don', 't', 's', 'm', 'll', 're', 've', 'im'
    ]);

    function words(text) {
        return String(text || '')
            // Keep letters, digits and the punctuation that separates words.
            .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
            .split(/\s+/)
            .filter(Boolean);
    }

    function isMeaningful(word) {
        var lower = word.toLowerCase().replace(/^['-]+|['-]+$/g, '');
        if (lower.length < 3) return false;
        if (STOP_WORDS.has(lower)) return false;
        return /[\p{L}\p{N}]/u.test(lower);
    }

    /** "Fixing CCTV Stream Output" style casing for the first word. */
    function titleCase(text) {
        return String(text)
            .split(/\s+/)
            .filter(Boolean)
            .map(function (word, index) {
                // Leave words that already carry internal capitals alone
                // (OpenAI, PostgreSQL, GPT-4o).
                if (/[A-Z]/.test(word.slice(1))) return word;
                if (index === 0) {
                    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
                }
                return word.toLowerCase();
            })
            .join(' ');
    }

    /**
     * Builds a label from the message text alone.
     *
     * Always returns something usable. It never throws and never returns an
     * empty string, because an untitled conversation is worse than a clumsy
     * one.
     */
    function keywordTitle(text) {
        var source = String(text || '').replace(/\s+/g, ' ').trim();
        if (source === '') return 'New chat';

        var all = words(source);
        var meaningful = all.filter(isMeaningful);

        // Nothing substantial: fall back to the first words verbatim rather than
        // returning nothing. "te" is a poor title, but it beats a blank sidebar.
        var chosen = meaningful.length >= MIN_WORDS
            ? meaningful.slice(0, MAX_WORDS)
            : all.slice(0, MAX_WORDS);

        if (chosen.length === 0) return 'New chat';

        var title = titleCase(chosen.join(' '));
        if (title.length > MAX_CHARS) {
            title = title.slice(0, MAX_CHARS).replace(/\s+\S*$/, '').trim();
        }
        return title === '' ? 'New chat' : title;
    }

    /**
     * Normalises whatever the model returned into a usable title.
     *
     * Models answer with quotes, trailing periods, "Title:" prefixes and
     * occasional refusals. Stripping all of that here means the caller never
     * has to trust the shape of the response.
     */
    function cleanAiTitle(value) {
        if (typeof value !== 'string') return null;
        var text = value
            .replace(/^\s*(?:title|summary)\s*[:\-]\s*/i, '')
            .replace(/^["'\u201C\u2018]+/, '')
            .replace(/["'\u201D\u2019]+$/, '')
            .replace(/[.\s]+$/, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (text === '') return null;
        // A model that ignored the instruction is not a title source.
        if (text.length > MAX_CHARS * 2) return null;
        if (text.length > MAX_CHARS) {
            text = text.slice(0, MAX_CHARS).replace(/\s+\S*$/, '').trim();
        }
        return text === '' ? null : text;
    }

    /**
     * Asks the model for a short title.
     *
     * Uses a dedicated non-streaming endpoint rather than /api/chat so a title
     * costs a few tokens instead of a full streamed turn, and so it does not
     * consume the chat rate limit. Any failure resolves to null and the
     * caller falls back — this must never surface an error to the user.
     */
    async function aiTitle(firstUserText, firstAssistantText, options) {
        var opts = options || {};
        if (opts.enabled === false || typeof global.fetch !== 'function') return null;

        try {
            var res = await global.fetch(opts.endpoint || '/api/title', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: String(firstUserText || '').slice(0, 2000),
                    reply: String(firstAssistantText || '').slice(0, 2000)
                })
            });

            if (!res.ok) return null;
            var data = await res.json();
            return cleanAiTitle(data && data.title);
        } catch (e) {
            return null;
        }
    }

    global.ChatBotTitle = {
        keywordTitle: keywordTitle,
        cleanAiTitle: cleanAiTitle,
        aiTitle: aiTitle,
        MAX_CHARS: MAX_CHARS,
        MAX_WORDS: MAX_WORDS,
        STOP_WORDS: STOP_WORDS
    };
})(typeof window !== 'undefined' ? window : globalThis);