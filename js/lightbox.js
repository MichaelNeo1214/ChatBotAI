/**
 * Image lightbox.
 *
 * Clicking an image in a message opens it full-screen with zoom and download.
 * Kept out of js/script.js because it is self-contained and has real edge cases
 * (escape/arrow keys, double-click to reset, download naming) that are much
 * easier to reason about — and test — on their own.
 *
 * Security: the image source is only ever a `data:image/...` URL produced by
 * this app, never fetched from a third party, so there is no origin to validate
 * against and nothing here can be pointed at an internal URL.
 */
(function (global) {
    'use strict';

    var doc = global.document;

    var state = {
        root: null,
        image: null,
        caption: null,
        zoom: 1,
        scale: 1,
        savedTransform: ''
    };

    var MIN_ZOOM = 0.5;
    var MAX_ZOOM = 5;
    var ZOOM_STEP = 0.25;

    /** Only data:image sources are accepted, so a crafted src cannot load a page. */
    function isSafeSource(src) {
        return typeof src === 'string' && src.indexOf('data:image/') === 0;
    }

    function ensureRoot() {
        if (state.root && state.root.isConnected) return state.root;

        var root = doc.createElement('div');
        root.className = 'lightbox';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', 'Image preview');
        root.hidden = true;

        var backdrop = doc.createElement('button');
        backdrop.type = 'button';
        backdrop.className = 'lightbox-backdrop';
        backdrop.setAttribute('aria-label', 'Close image preview');
        root.appendChild(backdrop);

        var img = doc.createElement('img');
        img.className = 'lightbox-image';
        img.alt = '';
        img.setAttribute('draggable', 'false');
        root.appendChild(img);

        var caption = doc.createElement('div');
        caption.className = 'lightbox-caption';
        root.appendChild(caption);

        var bar = doc.createElement('div');
        bar.className = 'lightbox-bar';

        var controls = [
            { label: 'Zoom out', text: '\u2212', action: function () { zoomBy(-ZOOM_STEP); } },
            { label: 'Reset zoom', text: '100%', action: function () { setZoom(1); }, className: 'lightbox-reset' },
            { label: 'Zoom in', text: '+', action: function () { zoomBy(ZOOM_STEP); } }
        ];

        controls.forEach(function (control) {
            var button = doc.createElement('button');
            button.type = 'button';
            button.className = 'lightbox-btn' + (control.className ? ' ' + control.className : '');
            button.textContent = control.text;
            button.setAttribute('aria-label', control.label);
            button.addEventListener('click', control.action);
            bar.appendChild(button);
        });

        var download = doc.createElement('button');
        download.type = 'button';
        download.className = 'lightbox-btn';
        download.textContent = 'Download';
        download.addEventListener('click', downloadCurrent);
        bar.appendChild(download);

        var close = doc.createElement('button');
        close.type = 'button';
        close.className = 'lightbox-btn lightbox-close';
        close.textContent = 'Close';
        close.addEventListener('click', close2);
        bar.appendChild(close);

        root.appendChild(bar);

        backdrop.addEventListener('click', close2);
        img.addEventListener('dblclick', function () { setZoom(state.zoom > 1 ? 1 : 2); });

        doc.body.appendChild(root);
        state.root = root;
        state.image = img;
        state.caption = caption;
        return root;
    }

    function applyTransform() {
        if (!state.image) return;
        state.image.style.transform = 'scale(' + state.zoom + ')';
        var reset = state.root && state.root.querySelector('.lightbox-reset');
        if (reset) reset.textContent = Math.round(state.zoom * 100) + '%';
    }

    function setZoom(value) {
        var clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
        // Two decimal places, otherwise repeated wheel steps drift into values
        // like 1.7500000000000002 in the label.
        state.zoom = Math.round(clamped * 100) / 100;
        applyTransform();
    }

    function zoomBy(delta) {
        setZoom(state.zoom + delta);
    }

    function downloadCurrent() {
        if (!state.image || !isSafeSource(state.image.src)) return;
        try {
            var anchor = doc.createElement('a');
            anchor.href = state.image.src;
            anchor.download = state.filename || 'image.png';
            doc.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
        } catch (e) {
            // A blocked download must not throw into the click handler.
        }
    }

    function open(src, caption, filename) {
        if (!isSafeSource(src)) return false;

        ensureRoot();
        state.filename = filename || 'image.png';
        state.image.src = src;
        state.image.alt = caption || 'Shared image';
        state.caption.textContent = caption || '';
        state.caption.hidden = !caption;
        state.root.hidden = false;
        // Start every open from a known zoom, not whatever the last one was.
        setZoom(1);
        return true;
    }

    function close2() {
        if (!state.root) return;
        state.root.hidden = true;
        // Release the decoded bitmap: a 4 MB data URL held open pins memory for
        // the rest of the session.
        state.image.removeAttribute('src');
    }

    function isOpen() {
        return !!(state.root && !state.root.hidden);
    }

    function onKeyDown(event) {
        if (!isOpen()) return;
        if (event.key === 'Escape') close2();
        else if (event.key === '+' || event.key === '=') zoomBy(ZOOM_STEP);
        else if (event.key === '-' || event.key === '_') zoomBy(-ZOOM_STEP);
        else if (event.key === '0') setZoom(1);
        else if (event.key === 'ArrowUp') { event.preventDefault(); zoomBy(ZOOM_STEP); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); zoomBy(-ZOOM_STEP); }
    }

    doc.addEventListener('keydown', onKeyDown);
    global.addEventListener('resize', function () {
        // A transform scale survives a resize; a fit-to-width style size would
        // not. Nothing to recompute here, but the hook keeps the contract clear.
    });

    /**
     * Opens any image inside `root` when it is clicked.
     *
     * Delegated rather than bound per image, because replies re-render on every
     * streamed chunk: a bound listener would be attached to the same node many
     * times and fire once per attachment.
     */
    function delegate(root) {
        if (!root || root.__lightboxBound) return;
        root.__lightboxBound = true;
        root.addEventListener('click', function (event) {
            const target = event.target;
            if (!target || target.tagName !== 'IMG') return;
            if (!target.classList.contains('message-image') && !target.classList.contains('share-image')) return;

            const caption = (target.alt || '').trim();
            open(target.src, caption, (target.alt || 'image').slice(0, 60).replace(/\.[^.]*$/, '') + '.png');
        });
    }

    global.ChatBotLightbox = {
        open: open,
        close: close2,
        delegate: delegate,
        isOpen: isOpen,
        setZoom: setZoom,
        zoomBy: zoomBy,
        MIN_ZOOM: MIN_ZOOM,
        MAX_ZOOM: MAX_ZOOM,
        isSafeSource: isSafeSource
    };
})(typeof window !== 'undefined' ? window : globalThis);