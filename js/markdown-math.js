/**
 * LaTeX extraction and rendering for the Markdown pipeline.
 *
 * Extracted from js/script.js so the delimiter rules — which are easy to get
 * subtly wrong and hard to see in a 4,000-line file — can be unit tested.
 *
 * ## Why math is lifted before HTML escaping
 *
 * `escapeHtml` in the Markdown pipeline turns `&` into `&amp;`. LaTeX uses `&`
 * for alignment inside matrices, arrays and aligned environments, so escaping
 * first would silently corrupt every one of them. Both extraction passes here
 * therefore run on raw text and only the rendered output enters the HTML.
 *
 * ## Why `$` is handled conservatively
 *
 * A lone dollar sign is also how people write prices. An inline span is only
 * treated as math when it is not padded with whitespace, does not open onto
 * another `$`, is not followed by a digit, and is not a bare number like `$5`
 * or `$12.50`. Display math (`$$`) has no such ambiguity and is matched
 * literally.
 */
(function (global) {
    'use strict';

    // Private-use characters, matching the placeholders the Markdown pipeline
    // already uses for code blocks and inline code.
    var BLOCK_PH = '\u0003MATHB';
    var INLINE_PH = '\u0002MI';
    var BLOCK_PH_RE = new RegExp('^' + BLOCK_PH + '(\\d+)\u0003$');
    var BLOCK_PH_SCAN_RE = new RegExp(BLOCK_PH + '(\\d+)\u0003', 'g');
    var INLINE_PH_SCAN_RE = new RegExp(INLINE_PH + '(\\d+)\\u0002', 'g');

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /** True when KaTeX has finished loading and can render. */
    function ready() {
        return typeof global.katex === 'object'
            && global.katex !== null
            && typeof global.katex.renderToString === 'function';
    }

    /**
     * Renders LaTeX to KaTeX markup, or to escaped source when KaTeX is absent.
     *
     * `trust` is left at KaTeX's own default of false, which is what blocks
     * \href, \htmlClass and \includegraphics from injecting markup. The
     * returned string is later passed through DOMPurify regardless.
     */
    function render(tex, displayMode) {
        if (ready()) {
            try {
                return global.katex.renderToString(tex, {
                    displayMode: !!displayMode,
                    throwOnError: false,
                    strict: false,
                    trust: false,
                    output: 'htmlAndMathml'
                });
            } catch (e) {
                // A malformed expression must degrade, not break the reply.
            }
        }
        return '<code class="math-raw">' + escapeHtml(tex) + '</code>';
    }

    /**
     * Lifts `$$...$$` out of a whole message.
     *
     * Pushes each expression onto `sink` and returns the text with a one-line
     * placeholder in its place, so the block parser treats it as its own block.
     */
    function extractBlocks(text, sink) {
        return String(text).replace(/\$\$([\s\S]+?)\$\$/g, function (_, tex) {
            var body = String(tex).replace(/^\s+|\s+$/g, '');
            if (body === '') return '';
            sink.push(body);
            return '\n' + BLOCK_PH + (sink.length - 1) + '\u0003\n';
        });
    }

    /**
     * Lifts inline `$...$` out of one already-parsed block.
     *
     * Run this after inline code has been extracted, so a `$` inside backticks
     * is already behind a placeholder and cannot be matched.
     */
    function extractInline(text, sink) {
        return String(text).replace(
            /\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\d)/g,
            function (match, tex) {
                var body = String(tex);
                // "$5", "$12.50" and "$.99" are prices, not maths.
                if (/^[\d.,]+$/.test(body.trim())) return match;
                sink.push(body);
                return INLINE_PH + (sink.length - 1) + '\u0002';
            }
        );
    }

    /** True when this line is a display-math placeholder. */
    function isBlockPlaceholder(line) {
        return BLOCK_PH_RE.test(String(line));
    }

    /** The sink index for a display-math placeholder line. */
    function blockIndex(line) {
        var m = BLOCK_PH_RE.exec(String(line));
        return m ? Number(m[1]) : -1;
    }

    /** Replaces every math placeholder with its rendered markup. */
    function restore(html, blocks, inlines) {
        return String(html)
            .replace(BLOCK_PH_SCAN_RE, function (_, n) {
                var tex = blocks[Number(n)];
                return tex === undefined ? '' : render(tex, true);
            })
            .replace(INLINE_PH_SCAN_RE, function (_, n) {
                var tex = inlines[Number(n)];
                return tex === undefined ? '' : render(tex, false);
            });
    }

    global.ChatBotMath = {
        BLOCK_PH: BLOCK_PH,
        INLINE_PH: INLINE_PH,
        ready: ready,
        render: render,
        extractBlocks: extractBlocks,
        extractInline: extractInline,
        isBlockPlaceholder: isBlockPlaceholder,
        blockIndex: blockIndex,
        restore: restore
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = global.ChatBotMath;
})(typeof window !== 'undefined' ? window : globalThis);