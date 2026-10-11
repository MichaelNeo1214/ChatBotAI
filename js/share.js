/**
 * Shareable conversation links.
 *
 * ## Why the payload is in the link
 *
 * The deployed functions are stateless serverless: there is no database and no
 * writable filesystem, so a share id cannot be looked up server-side without
 * adding one. Rather than make sharing depend on infrastructure the app does
 * not have, the conversation travels in the link itself.
 *
 * The trade-off is explicit: a long URL in exchange for a link that always
 * works, needs no credentials, costs nothing per view, and cannot leak other
 * users' data through a server-side id enumeration. Browsers handle fragments of
 * this size comfortably, and `MAX_PAYLOAD_BYTES` guards against producing a
 * link that some of them will refuse.
 *
 * The payload sits in the URL *fragment* (#) rather than the query string,
 * because fragments are not sent to servers or written to access logs.
 *
 * If a database is ever added, `share.ts` swaps the encoder for a short id and
 * the rest of the UI is unchanged.
 */
(function (global) {
    'use strict';

    var VERSION = 1;
    var PREFIX = 's1';

    /** Refuse to build a link larger than this; beyond it some clients choke. */
    var MAX_PAYLOAD_BYTES = 100 * 1024;
    /** Messages beyond this are dropped from the shared copy, newest kept. */
    var MAX_MESSAGES = 200;

    /**
     * UTF-8 safe base64. btoa() throws on any code point above U+00FF, which a
     * non-English conversation hits immediately, so the string is encoded to
     * UTF-8 bytes first.
     */
    function toBase64(text) {
        var bytes = new TextEncoder().encode(text);
        var binary = '';
        for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return global.btoa(binary);
    }

    function fromBase64(base64) {
        var binary = global.atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }

    /**
     * Trims a conversation down to what is safe and useful to share.
     *
     * Only role, text and image survive. Anything else on a message object —
     * client ids, transient flags, DOM references — is local bookkeeping and
     * would be noise in someone else's browser.
     *
     * `image` is omitted entirely when absent rather than set to '', because an
     * empty key on every message measurably bloats the encoded link and the
     * link is the whole transport.
     */
    function toSharedMessages(messages) {
        var out = [];
        var list = Array.isArray(messages) ? messages : [];

        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;

            var text = typeof m.text === 'string' ? m.text : '';
            var image = typeof m.image === 'string' && m.image.indexOf('data:image/') === 0
                ? m.image
                : '';

            if (text === '' && image === '') continue;

            var shared = { role: m.role, text: text };
            if (image !== '') shared.image = image;
            out.push(shared);
        }

        // Keep the most recent turns when trimming.
        return out.length > MAX_MESSAGES ? out.slice(-MAX_MESSAGES) : out;
    }

    /**
     * Builds the shareable link for a conversation.
     *
     * Returns { ok: false, reason } rather than throwing: an over-long
     * conversation is an expected outcome the UI offers to trim, not a bug.
     */
    function createShareLink(options) {
        var opts = options || {};
        var messages = toSharedMessages(opts.messages);
        if (messages.length === 0) {
            return { ok: false, reason: 'empty', message: 'There is nothing to share yet.' };
        }

        var payload = {
            v: VERSION,
            t: typeof opts.title === 'string' ? opts.title.slice(0, 200) : '',
            m: messages,
        };

        var encoded;
        try {
            encoded = toBase64(JSON.stringify(payload));
        } catch (e) {
            return { ok: false, reason: 'encode_failed', message: 'Could not encode this conversation.' };
        }

        if (encoded.length > MAX_PAYLOAD_BYTES) {
            return {
                ok: false,
                reason: 'too_large',
                message: 'This conversation is too long to share as a single link. ' +
                    'Try sharing fewer messages.',
            };
        }

        var base = (opts.origin || global.location.origin) + (opts.basePath || '');
        return {
            ok: true,
            url: base + '#/share/' + PREFIX + '.' + encoded,
            messageCount: messages.length,
        };
    }

    /** Reads a share payload out of a fragment. Returns null when there is none. */
    function parseShareToken(token) {
        if (typeof token !== 'string' || token === '') return null;

        var separator = token.indexOf('.');
        if (separator === -1) return null;

        var version = token.slice(0, separator);
        if (version !== PREFIX) return null;

        var encoded = token.slice(separator + 1);
        if (encoded === '') return null;

        var parsed;
        try {
            parsed = JSON.parse(fromBase64(encoded));
        } catch (e) {
            // A truncated or hand-edited link. Never surface the raw error.
            return null;
        }

        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.m)) return null;

        var messages = toSharedMessages(parsed.m);
        // A link that decodes to nothing usable is a broken link. Returning null
        // lets the UI say "this link is invalid" instead of rendering an empty
        // conversation that looks like the sender shared nothing on purpose.
        if (messages.length === 0) return null;

        return {
            title: typeof parsed.t === 'string' ? parsed.t : 'Shared conversation',
            messages: messages
        };
    }

    /**
     * Routes the current location.
     *
     * Returns one of:
     *   { name: 'share', token, id }   a read-only shared conversation
     *   { name: 'conversation', id }   a local conversation to open
     *   { name: 'home' }               the default view
     */
    function currentRoute(hash) {
        var raw = typeof hash === 'string' ? hash : (global.location.hash || '');
        var path = raw.replace(/^#/, '').replace(/^\/+/, '').replace(/\/+$/, '');
        if (path === '') return { name: 'home' };

        var parts = path.split('/').filter(Boolean);

        if (parts[0] === 'share' && parts[1]) {
            return { name: 'share', token: parts[1], id: parts[1] };
        }
        if (parts[0] === 'c' && parts[1]) {
            return { name: 'conversation', id: parts[1] };
        }
        // Unknown hash: fall back to the default view rather than a dead page.
        return { name: 'home' };
    }

    /** Renders a conversation as Markdown for export. */
    function toMarkdown(conversation) {
        var messages = toSharedMessages(conversation && conversation.messages);
        var lines = [];

        var title = (conversation && conversation.title) || 'Exported conversation';
        lines.push('# ' + title, '');

        for (var i = 0; i < messages.length; i++) {
            var m = messages[i];
            lines.push(m.role === 'user' ? '## You' : '## Assistant', '');
            if (m.image) lines.push('![Generated image](' + m.image + ')', '');
            if (m.text) lines.push(m.text, '');
        }

        lines.push('---', '', '_Exported from OpenRouter Free chat._');
        return lines.join('\n');
    }

    global.ChatBotShare = {
        VERSION: VERSION,
        PREFIX: PREFIX,
        MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES,
        MAX_MESSAGES: MAX_MESSAGES,

        createShareLink: createShareLink,
        parseShareToken: parseShareToken,
        currentRoute: currentRoute,
        toSharedMessages: toSharedMessages,
        toMarkdown: toMarkdown
    };
})(typeof window !== 'undefined' ? window : globalThis);
