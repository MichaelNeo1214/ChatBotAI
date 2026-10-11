/**
 * Read-only shared-conversation view.
 *
 * Loaded after js/share.js. Runs on load and on every hash change, so a shared
 * link pasted into any browser renders without a reload and a Back/Forward
 * between /share/… and the app works.
 *
 * The view is deliberately separate from the chat UI rather than a mode inside
 * it: a shared conversation has no session, no model and no composer, and
 * reaching into the chat app to hide those would couple a view that is mostly
 * static to a module with a lot of state. Nothing here can send a message.
 */
(function (global) {
    'use strict';

    var doc = global.document;
    var share = global.ChatBotShare;
    var notify = global.ChatBotUI && global.ChatBotUI.toast;

    function el(tag, className, text) {
        var node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function stop(event) {
        event.preventDefault();
        event.stopPropagation();
    }

    /**
     * Removes every interactive control from the page.
     *
     * Called before the shared transcript is rendered so that nothing inside a
     * message can be clicked. Hiding the composer is not enough on its own: a
     * stray send button would still be reachable by keyboard.
     */
    function enterReadOnlyMode() {
        if (doc.body.classList.contains('read-only-share')) return;
        doc.body.classList.add('read-only-share');

        // Everything that could change or destroy the conversation.
        var blocked = [
            'inputArea', 'settingsModalOverlay', 'keyAlertOverlay',
            'profileOverlay', 'searchPopup', 'sidebar', 'sidebarOverlay'
        ];
        blocked.forEach(function(id) {
            var node = doc.getElementById(id);
            if (node) node.hidden = true;
        });

        var composer = doc.querySelector('.input-area');
        if (composer) composer.hidden = true;

        // Strip tab order from anything left that could still act.
        doc.querySelectorAll('button, input, textarea, select, a[href]').forEach(function(node) {
            node.setAttribute('data-share-disabled', 'true');
            node.setAttribute('tabindex', '-1');
            if (node.tagName !== 'A') node.setAttribute('aria-hidden', 'true');
            // Capture-phase so it runs before the page's own handlers.
            node.addEventListener('click', stop, true);
            node.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') stop(e);
            }, true);
        });

        doc.body.classList.remove('chat-active');
    }

    function exitReadOnlyMode() {
        if (!doc.body.classList.contains('read-only-share')) return;
        doc.body.classList.remove('read-only-share');

        var host = doc.getElementById('shareView');
        if (host) host.remove();

        doc.querySelectorAll('[data-share-disabled]').forEach(function(node) {
            node.removeAttribute('data-share-disabled');
            node.removeAttribute('aria-hidden');
            node.removeAttribute('tabindex');
        });

        ['inputArea', 'sidebar'].forEach(function(id) {
            var node = doc.getElementById(id);
            if (node) node.hidden = false;
        });
        var composer = doc.querySelector('.input-area');
        if (composer) composer.hidden = false;
    }

    function showInvalidLink() {
        var host = doc.getElementById('shareView') || buildHost();
        host.innerHTML = '';

        var card = el('div', 'share-card share-invalid');
        card.appendChild(el('div', 'share-badge', 'Shared conversation'));
        card.appendChild(el('h1', 'share-title', 'This link could not be opened'));
        card.appendChild(el('p', 'share-desc',
            'The conversation data is missing or damaged. Ask the person who shared it to send a new link.'));

        var back = el('button', 'btn primary', 'Start a new chat');
        back.type = 'button';
        back.addEventListener('click', function() {
            global.location.hash = '';
        });
        card.appendChild(back);

        host.appendChild(card);
    }

    function buildHost() {
        var host = doc.getElementById('shareView');
        if (host) return host;

        host = el('div', 'share-view');
        host.id = 'shareView';
        doc.body.appendChild(host);
        return host;
    }

    /** Renders the transcript using the app's own Markdown pipeline. */
    function renderMessages(messages) {
        var host = buildHost();
        host.innerHTML = '';

        var card = el('div', 'share-card');

        var badge = el('div', 'share-badge');
        badge.appendChild(el('span', 'share-badge-dot'));
        badge.appendChild(el('span', null, 'Read-Only Shared Conversation'));
        card.appendChild(badge);

        var transcript = el('div', 'share-transcript');

        messages.forEach(function(message) {
            var row = el('div', 'share-message ' + message.role);
            row.appendChild(el('div', 'share-message-role', message.role === 'user' ? 'You' : 'Assistant'));

            if (message.image) {
                var img = el('img', 'share-image');
                img.src = message.image;
                img.alt = 'Shared image';
                img.loading = 'lazy';
                row.appendChild(img);
            }

            var body = el('div', 'share-message-body');
            if (message.text) {
                // Same renderer the app uses for its own replies, so Markdown,
                // LaTeX and code highlighting look identical. The pipeline
                // sanitises with DOMPurify before this reaches innerHTML.
                var format = global.__chatbotFormatText;
                if (typeof format === 'function') {
                    body.innerHTML = format(message.text);
                } else {
                    // Fallback keeps the text readable if the app script failed
                    // to load. textContent, never innerHTML: this is untrusted
                    // content arriving in a stranger's browser.
                    body.textContent = message.text;
                }
            }
            row.appendChild(body);
            transcript.appendChild(row);
        });

        card.appendChild(transcript);

        // "Continue in New Chat" copies the transcript into a fresh local
        // conversation so the visitor can pick it up from there.
        var fork = el('button', 'btn primary share-fork', 'Continue in New Chat');
        fork.type = 'button';
        fork.addEventListener('click', function() {
            if (typeof global.__chatbotForkConversation === 'function') {
                global.__chatbotForkConversation(messages);
                global.location.hash = '';
                return;
            }
            if (notify) notify('Forking is not available in this build.', { type: 'warn' });
        });
        card.appendChild(fork);

        var own = el('button', 'btn share-back', 'Open my chats');
        own.type = 'button';
        own.addEventListener('click', function() { global.location.hash = ''; });
        card.appendChild(own);

        host.appendChild(card);
    }

    function render() {
        if (!share) return;

        var route = share.currentRoute();
        if (route.name !== 'share') {
            exitReadOnlyMode();
            return;
        }

        enterReadOnlyMode();
        var parsed = share.parseShareToken(route.token);
        if (!parsed) {
            showInvalidLink();
            return;
        }

        doc.title = parsed.title + ' - Shared conversation';
        renderMessages(parsed.messages);
    }

    global.ChatBotShareView = { render: render, enterReadOnlyMode: enterReadOnlyMode, exitReadOnlyMode: exitReadOnlyMode };

    global.addEventListener('hashchange', render);
    doc.addEventListener('DOMContentLoaded', render);
})(window);
