        // ===== LOCAL STORE (provider keys + display profile) =====
        // Only things that belong to this browser live here. Conversations are
        // device-local too (IndexedDB, see below) and the sidebar is rendered
        // from that store; an account backend is optional and only mirrored.
        // The display profile stays namespaced per owner: 'guest' when signed
        // out, 'user:<id|email>' when signed in.
        window.ChatBotStore = (function() {
            const KEYS_KEY = 'chatbot.apikeys.v1';
            const PROF_BASE = 'chatbot.profile.v1';
            let owner = 'guest';

            function profKey() {
                return PROF_BASE + ':' + owner;
            }

            function read(key, fallback) {
                try {
                    const raw = localStorage.getItem(key);
                    if (!raw) return fallback;
                    return JSON.parse(raw);
                } catch (e) {
                    return fallback;
                }
            }

            function write(key, value) {
                try {
                    localStorage.setItem(key, JSON.stringify(value));
                    return true;
                } catch (e) {
                    return false;
                }
            }

            function defaultKeys() {
                return {
                    openai: '', gemini: '', claude: '', deepseek: '', groq: '',
                    openaiBaseUrl: '', geminiBaseUrl: '', claudeBaseUrl: '', deepseekBaseUrl: '', groqBaseUrl: '',
                    openaiModel: '', geminiModel: '', claudeModel: '', deepseekModel: '', groqModel: '',
                    defaultBaseUrl: '', defaultModel: ''
                };
            }

            return {
                setOwner: function(next) {
                    owner = (next && String(next)) || 'guest';
                },
                getOwner: function() {
                    return owner;
                },
                loadKeys: function() {
                    const saved = read(KEYS_KEY, {});
                    const keys = defaultKeys();
                    Object.keys(keys).forEach(function(k) {
                        if (typeof saved[k] === 'string') keys[k] = saved[k];
                    });
                    return keys;
                },
                saveKeys: function(keys) {
                    const base = defaultKeys();
                    const out = {};
                    Object.keys(base).forEach(function(k) {
                        out[k] = (keys && typeof keys[k] === 'string') ? keys[k] : base[k];
                    });
                    return write(KEYS_KEY, out);
                },
                loadProfile: function() {
                    const saved = read(profKey(), {});
                    return {
                        name: typeof saved.name === 'string' ? saved.name : '',
                        photo: typeof saved.photo === 'string' ? saved.photo : ''
                    };
                },
                saveProfile: function(profile) {
                    return write(profKey(), {
                        name: profile && typeof profile.name === 'string' ? profile.name : '',
                        photo: profile && typeof profile.photo === 'string' ? profile.photo : ''
                    });
                },
                clearProfile: function(which) {
                    try {
                        localStorage.removeItem(PROF_BASE + ':' + ((which && String(which)) || owner));
                    } catch (e) {}
                }
            };
        })();

        (function() {
            'use strict';

            // Elements
            const sidebar = document.getElementById('sidebar');
            const overlay = document.getElementById('sidebarOverlay');
            const btnOpen = document.getElementById('btnOpenSidebar');
            const btnNewChat = document.getElementById('btnNewChat');
            const chatInput = document.getElementById('chatInput');
            const btnSend = document.getElementById('btnSend');
            const btnScrollBottom = document.getElementById('btnScrollBottom');
            const btnThemeToggle = document.getElementById('btnThemeToggle');
            const chatArea = document.getElementById('chatArea');
            const messagesWrapper = document.getElementById('messagesWrapper');
            const welcomeScreen = document.getElementById('welcomeScreen');
            const typingIndicator = document.getElementById('typingIndicator');
            const chatHistoryNav = document.getElementById('chatHistory');
            const quickActions = document.querySelectorAll('.quick-action');
            const btnModelDropdown = document.getElementById('btnModelDropdown');
            const modelDropdown = document.getElementById('modelDropdown');
            const modelOptions = document.querySelectorAll('.model-option');
            const currentModel = document.getElementById('currentModel');
            const userBtn = document.getElementById('userBtn');
            const userMenu = document.getElementById('userMenu');
            const userAvatar = document.getElementById('userAvatar');
            const userName = document.getElementById('userName');
            const userPlan = document.getElementById('userPlan');
            const menuSignIn = document.getElementById('menuSignIn');
            const menuProfile = document.getElementById('menuProfile');
            const menuSettings = document.getElementById('menuSettings');
            const menuHelp = document.getElementById('menuHelp');
            const menuSignOut = document.getElementById('menuSignOut');


            
            // State
            let chatStarted = false;
            let sending = false;
            let activeAbort = null;
            let isPinnedToBottom = true;
            let lastTurn = { raw: '', files: [] };
            const attachedFiles = [];
            // Lightweight client-side RAG: the extracted text of a PDF/TXT the
            // user attached for the *next* turn. Held as plain capped text (never
            // the File/ArrayBuffer) so a large document can't pin memory.
            let ragDoc = null;
            let conversations = [];
            // Every conversation ("session") lives in IndexedDB; the sidebar is a
            // projection of this list. `conversations` is the render-ready form.
            let sessions = [];
            let activeConversationId = null;
            let currentModelKey = 'default';

            // The open conversation is remembered across reloads so the next turn
            // appends to the same session instead of forking a new one.
            const ACTIVE_CONV_LS_KEY = 'chatbotai_active_conversation_id';

            function setActiveConversationId(id) {
                activeConversationId = id || null;
                try {
                    if (activeConversationId) localStorage.setItem(ACTIVE_CONV_LS_KEY, activeConversationId);
                    else localStorage.removeItem(ACTIVE_CONV_LS_KEY);
                } catch (e) {}
            }

            function storedActiveConversationId() {
                try { return localStorage.getItem(ACTIVE_CONV_LS_KEY); } catch (e) { return null; }
            }

            // ===== MODELS =====
            // `label` is the wire value: it is what the server routes on. The
            // matching localStorage key for a BYOK model is `key`.
            const MODEL_DEFS = [
                { key: 'default',  label: 'ChatBot AI', provider: 'default' },
                { key: 'openai',   label: 'GPT-4o',     provider: 'openai' },
                { key: 'gemini',   label: 'Gemini',     provider: 'gemini' },
                { key: 'claude',   label: 'Claude',     provider: 'anthropic' },
                { key: 'deepseek', label: 'DeepSeek',   provider: 'deepseek' },
                { key: 'groq',     label: 'Groq',       provider: 'groq' },
                { key: 'image',    label: 'Image',      provider: 'image' }
            ];

            function modelDef(key) {
                for (let i = 0; i < MODEL_DEFS.length; i++) {
                    if (MODEL_DEFS[i].key === key) return MODEL_DEFS[i];
                }
                return MODEL_DEFS[0];
            }

            function modelKeyFromLabel(label) {
                for (let i = 0; i < MODEL_DEFS.length; i++) {
                    if (MODEL_DEFS[i].label === label) return MODEL_DEFS[i].key;
                }
                return 'default';
            }

            /**
             * Human-readable name for a picker key or a server-sent label.
             *
             * The server reports a missing key against the label it was sent
             * ("GPT-4o"), so lookups accept both spellings.
             */
            function modelLabelFor(value) {
                for (let i = 0; i < MODEL_DEFS.length; i++) {
                    if (MODEL_DEFS[i].key === value || MODEL_DEFS[i].label === value) return MODEL_DEFS[i].label;
                }
                return value ? String(value) : 'This model';
            }

            function setModelPicker(key) {
                const def = modelDef(key);
                currentModelKey = def.key;
                modelOptions.forEach(function(o) {
                    o.classList.toggle('active', o.getAttribute('data-model') === def.label);
                });
                if (currentModel) currentModel.textContent = def.label;
            }

            function getApiKeys() {
                return window.ChatBotStore.loadKeys();
            }

            function modelHasKey(key) {
                if (key === 'default') return true;
                if (key === 'image') return !!imageBackend();
                const keys = getApiKeys();
                return !!(keys[key] && keys[key].trim());
            }

            // The Image model has no key of its own: it borrows whichever
            // image-capable BYOK key is set, preferring OpenAI over Gemini.
            // Returns null when neither is configured (the UI then prompts).
            function imageBackend() {
                const keys = getApiKeys();
                const openai = String(keys.openai || '').trim();
                if (openai) return { provider: 'openai', key: openai };
                const gemini = String(keys.gemini || '').trim();
                if (gemini) return { provider: 'gemini', key: gemini };
                return null;
            }

            // The assistant bubble text for a turn: the message, plus a plain
            // note naming the attachments. The backend takes no file bytes, so
            // this line is all a model ever sees about them.
            function buildUserText(text, files) {
                const raw = (text || '').trim();
                if (!files || !files.length) return raw;
                const names = files.map(function(f) { return f.name; }).join(', ');
                return (raw ? raw + '\n' : '') + '[Attached files: ' + names + ']';
            }

            // Turns a non-2xx JSON body into an Error carrying the contract's
            // code/model fields, so the caller can react to missing_api_key.
            async function backendError(res) {
                let detail = null;
                try {
                    detail = await res.json();
                } catch (e) {}
                const err = detail && detail.error ? detail.error : null;
                const out = new Error((err && err.message) ? err.message : 'HTTP ' + res.status);
                out.status = res.status;
                out.code = err ? err.code : undefined;
                out.model = err ? err.model : undefined;
                return out;
            }

            // ===== PROVIDER REQUEST ERRORS =====
            function requestFailed(url, e) {
                if (e && e.name === 'AbortError') {
                    return 'Request to ' + url + ' timed out. The model may still be loading — please try again.';
                }
                return 'Cannot reach ' + url + ' (' + ((e && e.message) ? e.message : 'network error') + ').';
            }

            // ===== BACKEND CHAT =====
            // Every assistant turn goes to POST /api/chat on this same origin.
            // The browser never talks to a provider domain: the server holds the
            // keys, picks the upstream, persists the conversation, and streams
            // the answer back as SSE.
            const API_BASE = '/api';

            /**
             * BYOK headers for a non-default model.
             *
             * The picker label is what the server routes on; the saved key and
             * any base URL / model override for that provider travel alongside
             * it, and are held only for the duration of the request.
             */
            function providerHeadersFor(key, keys) {
                const def = modelDef(key);
                const headers = {};
                if (def.provider === 'default') return headers;

                const apiKey = String(keys[def.key] || '').trim();
                if (apiKey) headers['X-Provider-Key'] = apiKey;

                const baseUrl = String(keys[def.key + 'BaseUrl'] || '').trim();
                if (baseUrl) headers['X-Provider-Base-Url'] = baseUrl.replace(/\/+$/, '');

                const model = String(keys[def.key + 'Model'] || '').trim();
                if (model) headers['X-Provider-Model'] = model;

                return headers;
            }

            /**
             * Reads one SSE line into `state`, dispatching on a blank line.
             *
             * `state.event` / `state.data` accumulate a single event's fields.
             * A blank line ends the event and hands it to `dispatch`.
             */
            function feedSseLine(line, state, dispatch) {
                if (line === '') {
                    if (state.data.length === 0 && state.event === '') return;
                    dispatch(state.event, state.data.join('\n'));
                    state.event = '';
                    state.data = [];
                    return;
                }
                if (line.charAt(0) === ':') return; // comment / keep-alive
                const colon = line.indexOf(':');
                const field = colon === -1 ? line : line.slice(0, colon);
                let value = colon === -1 ? '' : line.slice(colon + 1);
                if (value.charAt(0) === ' ') value = value.slice(1);

                if (field === 'event') state.event = value;
                else if (field === 'data') state.data.push(value);
            }

            /**
             * Streams one assistant turn from POST /api/chat.
             *
             * `onDelta` receives every chunk of text as it arrives, so the
             * caller can paint the reply incrementally. Resolves with
             * { conversationId, content }; the caller adopts the id when the
             * server created a new conversation for this turn.
             */
            async function callAssistant(modelKey, text, files, onDelta, signal, ragText) {
                const def = modelDef(modelKey);

                // Lightweight RAG: fold the attached document's text into this
                // single turn as a hidden context block. The visible user bubble
                // still shows only the question (built separately by the caller).
                let message = buildUserText(text, files);
                if (ragText) {
                    message = '[CONTEXT:\n' + ragText + '\n]\n\n'
                        + 'Based on the context above, answer this question: ' + message;
                }

                // Send the prior turns so a stateless backend (e.g. the Vercel
                // serverless function) can rebuild the context without a database.
                // The current turn is re-sent as `message`, so the history stops
                // just before the last user message. The local Express backend
                // ignores this extra field and keeps using its own DB.
                let lastUserId = -1;
                for (let i = 0; i < chatHistory.length; i++) {
                    if (chatHistory[i] && chatHistory[i].role === 'user') lastUserId = i;
                }
                const history = (lastUserId > 0 ? chatHistory.slice(0, lastUserId) : [])
                    .map(function(m) {
                        return {
                            role: m.role === 'user' ? 'user' : 'assistant',
                            content: String(m.text || '')
                        };
                    })
                    .filter(function(m) { return m.content !== ''; })
                    .slice(-40);

                const payload = {
                    message: message,
                    model: def.label
                };
                if (history.length) payload.history = history;
                if (activeConversationId) payload.conversationId = activeConversationId;

                const headers = Object.assign(
                    { 'Content-Type': 'application/json' },
                    providerHeadersFor(modelKey, getApiKeys())
                );

                let res;
                try {
                    res = await fetch(API_BASE + '/chat', {
                        method: 'POST',
                        headers: headers,
                        credentials: 'same-origin',
                        body: JSON.stringify(payload),
                        signal: signal
                    });
                } catch (e) {
                    // A user-initiated abort is not a connectivity failure.
                    if (e && e.name === 'AbortError') throw e;
                    throw new Error(requestFailed('the server', e));
                }

                if (!res.ok) throw await backendError(res);
                if (!res.body) throw new Error('Streaming is not supported by this browser.');

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                const state = { event: '', data: [] };
                let buffer = '';
                let conversationId = null;
                let content = '';
                let streamError = null;

                const dispatch = function(event, data) {
                    if (data === '' || data === '[DONE]') return;
                    let parsed;
                    try {
                        parsed = JSON.parse(data);
                    } catch (e) {
                        return; // a partial frame or a non-JSON keep-alive
                    }
                    if (event === 'meta') {
                        if (parsed.conversationId) conversationId = parsed.conversationId;
                    } else if (event === 'delta') {
                        if (typeof parsed.text === 'string' && parsed.text !== '') {
                            content += parsed.text;
                            onDelta(parsed.text);
                        }
                    } else if (event === 'done') {
                        if (typeof parsed.content === 'string') content = parsed.content;
                    } else if (event === 'error') {
                        streamError = new Error(parsed.message || 'The assistant failed to finish this response.');
                    }
                };

                try {
                    for (;;) {
                        const step = await reader.read();
                        if (step.done) break;
                        // A chunk can end mid-event, so only whole lines are
                        // consumed and the tail stays in the buffer.
                        buffer += decoder.decode(step.value, { stream: true });
                        let newline;
                        while ((newline = buffer.indexOf('\n')) !== -1) {
                            let line = buffer.slice(0, newline);
                            buffer = buffer.slice(newline + 1);
                            if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
                            feedSseLine(line, state, dispatch);
                        }
                    }
                    buffer += decoder.decode();
                    if (buffer !== '') feedSseLine(buffer.replace(/\r$/, ''), state, dispatch);
                    feedSseLine('', state, dispatch);
                } finally {
                    if (typeof reader.releaseLock === 'function') reader.releaseLock();
                }

                if (streamError) {
                    // Keep whatever arrived before the failure; the server saved
                    // the same partial turn, so the view matches a reload.
                    streamError.partial = content;
                    throw streamError;
                }
                if (content === '') throw new Error('The assistant returned an empty reply.');
                return { conversationId: conversationId, content: content };
            }

            // ===== BACKEND (optional account service) =====

            // ===== AUTH (session via /api backend when present; guest otherwise) =====
            let currentUser = null;

            function ownerKey() {
                return currentUser ? ('user:' + (currentUser.id || currentUser.email)) : 'guest';
            }

            function applyOwner() {
                // Only the display profile is per-owner in this browser; the
                // conversation list comes from the API for whoever the server
                // says is asking.
                window.ChatBotStore.setOwner(ownerKey());
            }

            // Display name/photo: local per-owner profile overrides account data.
            function resolveProfile() {
                const stored = window.ChatBotStore.loadProfile();
                const baseName = currentUser ? (currentUser.name || currentUser.email || 'User') : 'User';
                return {
                    name: (stored.name && stored.name.trim()) ? stored.name.trim() : baseName,
                    photo: stored.photo || ''
                };
            }

            function paintAvatar(el, photo, initial) {
                if (!el) return;
                if (photo) {
                    el.textContent = '';
                    const img = document.createElement('img');
                    img.src = photo;
                    img.alt = '';
                    el.appendChild(img);
                } else {
                    el.textContent = initial;
                }
            }

            function renderFooter() {
                const profile = resolveProfile();
                const initial = (profile.name.trim().charAt(0) || 'U').toUpperCase();
                paintAvatar(userAvatar, profile.photo, initial);
                if (userName) userName.textContent = profile.name;
                if (userPlan) userPlan.textContent = currentUser ? (currentUser.email || 'Free Plan') : 'Free Plan';
                if (menuSignIn) menuSignIn.hidden = !!currentUser;
                if (menuSignOut) menuSignOut.hidden = !currentUser;
            }

            function closeUserMenu() {
                if (userMenu) userMenu.hidden = true;
                if (userBtn) userBtn.setAttribute('aria-expanded', 'false');
            }

            function resetChatView() {
                activeConversationId = null;
                chatStarted = false;
                welcomeScreen.style.display = '';
                messagesWrapper.classList.remove('visible');
                messagesWrapper.innerHTML = '';
                chatInput.value = '';
                chatInput.style.height = 'auto';
                attachedFiles.length = 0;
                const filePreviewArea = document.getElementById('filePreviewArea');
                if (filePreviewArea) {
                    filePreviewArea.innerHTML = '';
                    filePreviewArea.hidden = true;
                }
                clearRagDoc();
                updateSendState();
                renderHistory();
            }

            function notifyAccountPanel() {
                if (window.ChatBotAuth && typeof window.ChatBotAuth.refreshAccountPanel === 'function') {
                    window.ChatBotAuth.refreshAccountPanel();
                }
            }

            async function refreshAuth() {
                let user = null;
                try {
                    const r = await fetch(API_BASE + '/auth/me', { credentials: 'same-origin' });
                    const d = await r.json();
                    user = d && d.user ? d.user : null;
                } catch (e) {
                    user = null;
                }
                currentUser = user;
                applyOwner();
                renderFooter();
                notifyAccountPanel();
                // The view is always rebuilt after auth resolves so the history
                // shown matches the active owner (guest or account).
                resetChatView();
                await refreshConversations();
                return user;
            }

            async function doSignOut(everywhere) {
                // "Log out everywhere" needs this browser's session to still be
                // valid, so it runs before the plain logout.
                if (everywhere) {
                    try {
                        await fetch(API_BASE + '/auth/logout-all', { method: 'POST', credentials: 'same-origin' });
                    } catch (e) {}
                }
                try {
                    await fetch(API_BASE + '/auth/logout', { method: 'POST', credentials: 'same-origin' });
                } catch (e) {}
                currentUser = null;
                applyOwner();
                renderFooter();
                notifyAccountPanel();
                resetChatView();
                // Signing out switches the owner the server scopes to, so the
                // sidebar is re-read rather than assumed.
                await refreshConversations();
            }

            async function deleteAccount() {
                if (!currentUser) return false;
                try {
                    // The endpoint requires an explicit confirmation in the body.
                    await fetch(API_BASE + '/auth/account', {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({ confirm: true })
                    });
                } catch (e) {}
                await doSignOut(false);
                return true;
            }

            window.ChatBotAuth = window.ChatBotAuth || {};
            window.ChatBotAuth.getUser = function() { return currentUser; };
            window.ChatBotAuth.signOut = function(everywhere) { return doSignOut(!!everywhere); };
            window.ChatBotAuth.deleteAccount = function() { return deleteAccount(); };

            // After auth resolves, rebuild the last local thread (IndexedDB).
            refreshAuth().then(function() {
                restoreLocalHistory();
            });

            // ===== SIDEBAR FOOTER USER MENU (opens upward) =====
            const HELP_TEXT = 'Here is how to use ChatBot AI:\n\n'
                + '**Start chatting** — type below and press Enter. Use New chat to start over.\n\n'
                + '**History** — every chat is saved on this device (and to your account when signed in). Rename with the pencil icon, delete with the trash icon, click any item to continue it.\n\n'
                + '**Models** — pick a model from the dropdown in the input box. "ChatBot AI" is the server\'s own model; GPT-4o, Gemini, Claude, DeepSeek and Groq are sent through the server with the API key you save in Settings → API Key.\n\n'
                + '**Images** — pick "Image" (or type /image followed by a description) to generate a picture. It uses your OpenAI or Gemini key, whichever is saved.\n\n'
                + '**Attachments** — the + button can upload files, dictate voice, create image prompts, and attach plugin or skill tags. Only the file names travel with your message; file contents are not uploaded.\n\n'
                + '**Account** — sign in to keep your chat history on your account. Signing out clears the view; signing back in reloads your saved chats.';

            function showHelpChat() {
                activeConversationId = null;
                chatStarted = true;
                welcomeScreen.style.display = 'none';
                messagesWrapper.classList.add('visible');
                messagesWrapper.innerHTML = '';
                const helpBubble = addMessage('assistant', HELP_TEXT);
                if (helpBubble && helpBubble.element) {
                    helpBubble.element.setAttribute('data-transient', 'true');
                }
                renderHistory();
                isPinnedToBottom = true;
                scrollToBottom(true);
                if (getBreakpoint() !== 'desktop') {
                    closeSidebar();
                }
                chatInput.focus();
            }

            if (userBtn && userMenu) {
                userBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const willOpen = userMenu.hidden;
                    userMenu.hidden = !willOpen;
                    userBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
                });
                userMenu.addEventListener('click', function(e) {
                    e.stopPropagation();
                });
            }

            if (menuSignIn) {
                menuSignIn.addEventListener('click', function() {
                    closeUserMenu();
                    window.location.assign('./components/auth/signup.html');
                });
            }

            if (menuSettings) {
                menuSettings.addEventListener('click', function() {
                    closeUserMenu();
                    if (window.ChatBotSettings && typeof window.ChatBotSettings.openPanel === 'function') {
                        window.ChatBotSettings.openPanel('general');
                    }
                });
            }

            if (menuHelp) {
                menuHelp.addEventListener('click', function() {
                    closeUserMenu();
                    showHelpChat();
                });
            }

            if (menuSignOut) {
                menuSignOut.addEventListener('click', function() {
                    closeUserMenu();
                    doSignOut(false);
                });
            }

            // ===== PROFILE POPUP (photo + rename + email) =====
            const profileOverlay = document.getElementById('profileOverlay');
            const profileMain = document.getElementById('profileMain');
            const profileCropView = document.getElementById('profileCrop');
            const profilePhoto = document.getElementById('profilePhoto');
            const profileName = document.getElementById('profileName');
            const profileEmail = document.getElementById('profileEmail');
            const profileError = document.getElementById('profileError');
            const btnPhotoEdit = document.getElementById('btnPhotoEdit');
            const photoInput = document.getElementById('photoInput');
            const btnRenameProfile = document.getElementById('btnRenameProfile');
            const btnProfileClose = document.getElementById('btnProfileClose');
            const cropCanvas = document.getElementById('cropCanvas');
            const cropZoom = document.getElementById('cropZoom');
            const btnCropSave = document.getElementById('btnCropSave');
            const btnCropCancel = document.getElementById('btnCropCancel');

            function showProfileError(msg) {
                if (!profileError) return;
                if (!msg) {
                    profileError.hidden = true;
                    profileError.textContent = '';
                } else {
                    profileError.textContent = msg;
                    profileError.hidden = false;
                }
            }

            function refreshProfileView() {
                const profile = resolveProfile();
                const initial = (profile.name.trim().charAt(0) || 'U').toUpperCase();
                paintAvatar(profilePhoto, profile.photo, initial);
                if (profileName) profileName.textContent = profile.name;
                if (profileEmail) {
                    profileEmail.textContent = currentUser ? (currentUser.email || 'Signed in') : 'Not signed in';
                }
            }

            function openProfile() {
                if (!profileOverlay) return;
                showProfileError(null);
                exitCropMode();
                refreshProfileView();
                profileOverlay.hidden = false;
            }

            function closeProfile() {
                if (profileOverlay) profileOverlay.hidden = true;
                exitCropMode();
                if (photoInput) photoInput.value = '';
            }

            if (menuProfile) {
                menuProfile.addEventListener('click', function() {
                    closeUserMenu();
                    openProfile();
                });
            }

            if (btnProfileClose) {
                btnProfileClose.addEventListener('click', closeProfile);
            }

            if (profileOverlay) {
                profileOverlay.addEventListener('click', function(e) {
                    if (e.target === profileOverlay) closeProfile();
                });
            }

            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape' && profileOverlay && !profileOverlay.hidden) {
                    if (profileOverlay.querySelector('.profile-name-input')) return;
                    closeProfile();
                }
            });

            // Rename display name (stored per owner, overrides account name).
            if (btnRenameProfile) {
                btnRenameProfile.addEventListener('click', function() {
                    if (!profileName || profileName.querySelector('.profile-name-input')) return;
                    const stored = window.ChatBotStore.loadProfile();
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'profile-name-input';
                    input.value = stored.name || '';
                    input.placeholder = resolveProfile().name;
                    input.setAttribute('aria-label', 'Display name');
                    input.maxLength = 40;
                    let done = false;
                    function commit(save) {
                        if (done) return;
                        done = true;
                        if (save) {
                            const v = input.value.trim();
                            const next = window.ChatBotStore.loadProfile();
                            next.name = v;
                            if (!window.ChatBotStore.saveProfile(next)) {
                                showProfileError('Could not save name (browser storage is unavailable).');
                            } else {
                                showProfileError(null);
                            }
                            refreshProfileView();
                            renderFooter();
                        } else {
                            refreshProfileView();
                        }
                    }
                    input.addEventListener('click', function(ev) { ev.stopPropagation(); });
                    input.addEventListener('keydown', function(ev) {
                        ev.stopPropagation();
                        if (ev.key === 'Enter') commit(true);
                        else if (ev.key === 'Escape') commit(false);
                    });
                    input.addEventListener('blur', function() { commit(true); });
                    profileName.textContent = '';
                    profileName.appendChild(input);
                    input.focus();
                    input.select();
                });
            }

            // Photo crop engine: drag to pan, slider to zoom, save 256px JPEG.
            const cropState = { img: null, zoom: 1, ox: 0, oy: 0, dragging: false, sx: 0, sy: 0, sox: 0, soy: 0 };

            function cropBaseScale() {
                if (!cropState.img || !cropCanvas) return 1;
                return Math.max(cropCanvas.width / cropState.img.naturalWidth, cropCanvas.height / cropState.img.naturalHeight);
            }

            function clampCropOffset() {
                if (!cropState.img || !cropCanvas) return;
                const s = cropBaseScale() * cropState.zoom;
                const dw = cropState.img.naturalWidth * s;
                const dh = cropState.img.naturalHeight * s;
                const maxX = Math.max(0, (dw - cropCanvas.width) / 2);
                const maxY = Math.max(0, (dh - cropCanvas.height) / 2);
                cropState.ox = Math.min(maxX, Math.max(-maxX, cropState.ox));
                cropState.oy = Math.min(maxY, Math.max(-maxY, cropState.oy));
            }

            function drawCrop() {
                if (!cropState.img || !cropCanvas) return;
                const ctx = cropCanvas.getContext('2d');
                if (!ctx) return;
                clampCropOffset();
                const s = cropBaseScale() * cropState.zoom;
                const dw = cropState.img.naturalWidth * s;
                const dh = cropState.img.naturalHeight * s;
                ctx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
                ctx.drawImage(cropState.img, (cropCanvas.width - dw) / 2 + cropState.ox, (cropCanvas.height - dh) / 2 + cropState.oy, dw, dh);
            }

            function enterCropMode() {
                if (profileMain) profileMain.hidden = true;
                if (profileCropView) profileCropView.hidden = false;
                showProfileError(null);
                drawCrop();
            }

            function exitCropMode() {
                cropState.img = null;
                cropState.zoom = 1;
                cropState.ox = 0;
                cropState.oy = 0;
                cropState.dragging = false;
                if (cropZoom) cropZoom.value = '1';
                if (profileCropView) profileCropView.hidden = true;
                if (profileMain) profileMain.hidden = false;
            }

            if (btnPhotoEdit && photoInput) {
                btnPhotoEdit.addEventListener('click', function() {
                    photoInput.click();
                });
                photoInput.addEventListener('change', function() {
                    const file = photoInput.files && photoInput.files[0];
                    if (!file) return;
                    if (!file.type || file.type.indexOf('image/') !== 0) {
                        showProfileError('Please choose an image file.');
                        photoInput.value = '';
                        return;
                    }
                    if (file.size > 8 * 1024 * 1024) {
                        showProfileError('Image is too large (max 8 MB).');
                        photoInput.value = '';
                        return;
                    }
                    const reader = new FileReader();
                    reader.onload = function() {
                        const img = new Image();
                        img.onload = function() {
                            cropState.img = img;
                            cropState.zoom = 1;
                            cropState.ox = 0;
                            cropState.oy = 0;
                            if (cropZoom) cropZoom.value = '1';
                            enterCropMode();
                        };
                        img.onerror = function() {
                            showProfileError('Could not read that image.');
                            photoInput.value = '';
                        };
                        img.src = reader.result;
                    };
                    reader.onerror = function() {
                        showProfileError('Could not read that file.');
                        photoInput.value = '';
                    };
                    reader.readAsDataURL(file);
                });
            }

            if (cropZoom) {
                cropZoom.addEventListener('input', function() {
                    cropState.zoom = parseFloat(cropZoom.value) || 1;
                    drawCrop();
                });
            }

            if (cropCanvas) {
                cropCanvas.addEventListener('pointerdown', function(e) {
                    if (!cropState.img) return;
                    cropState.dragging = true;
                    cropState.sx = e.clientX;
                    cropState.sy = e.clientY;
                    cropState.sox = cropState.ox;
                    cropState.soy = cropState.oy;
                    try { cropCanvas.setPointerCapture(e.pointerId); } catch (err) {}
                });
                cropCanvas.addEventListener('pointermove', function(e) {
                    if (!cropState.dragging || !cropState.img) return;
                    const rect = cropCanvas.getBoundingClientRect();
                    const scale = cropCanvas.width / rect.width;
                    cropState.ox = cropState.sox + (e.clientX - cropState.sx) * scale;
                    cropState.oy = cropState.soy + (e.clientY - cropState.sy) * scale;
                    drawCrop();
                });
                function endDrag() { cropState.dragging = false; }
                cropCanvas.addEventListener('pointerup', endDrag);
                cropCanvas.addEventListener('pointercancel', endDrag);
            }

            if (btnCropCancel) {
                btnCropCancel.addEventListener('click', function() {
                    exitCropMode();
                    if (photoInput) photoInput.value = '';
                });
            }

            if (btnCropSave) {
                btnCropSave.addEventListener('click', function() {
                    if (!cropState.img) {
                        exitCropMode();
                        return;
                    }
                    try {
                        const out = document.createElement('canvas');
                        out.width = 256;
                        out.height = 256;
                        const ctx = out.getContext('2d');
                        const s = cropBaseScale() * cropState.zoom;
                        const k = 256 / cropCanvas.width;
                        const dw = cropState.img.naturalWidth * s * k;
                        const dh = cropState.img.naturalHeight * s * k;
                        ctx.fillStyle = '#000';
                        ctx.fillRect(0, 0, 256, 256);
                        ctx.drawImage(cropState.img, (256 - dw) / 2 + cropState.ox * k, (256 - dh) / 2 + cropState.oy * k, dw, dh);
                        const dataUrl = out.toDataURL('image/jpeg', 0.85);
                        const next = window.ChatBotStore.loadProfile();
                        next.photo = dataUrl;
                        if (!window.ChatBotStore.saveProfile(next)) {
                            showProfileError('Could not save photo (browser storage is full or unavailable).');
                            return;
                        }
                        showProfileError(null);
                        refreshProfileView();
                        renderFooter();
                        exitCropMode();
                        if (photoInput) photoInput.value = '';
                    } catch (err) {
                        showProfileError('Could not save photo.');
                    }
                });
            }

            // ===== SIDEBAR TOGGLE =====
            function getBreakpoint() {
                const w = window.innerWidth;
                if (w <= 768) return 'mobile';
                if (w <= 1024) return 'tablet';
                return 'desktop';
            }

            function isSidebarVisible() {
                return !sidebar.classList.contains('collapsed');
            }

            function openSidebar() {
                sidebar.classList.remove('collapsed');
                if (getBreakpoint() !== 'desktop') {
                    overlay.classList.add('visible');
                    document.body.style.overflow = 'hidden';
                }
            }

            function closeSidebar() {
                sidebar.classList.add('collapsed');
                overlay.classList.remove('visible');
                document.body.style.overflow = '';
            }

            function toggleSidebar() {
                if (isSidebarVisible()) {
                    closeSidebar();
                } else {
                    openSidebar();
                }
            }

            btnOpen.addEventListener('click', toggleSidebar);
            overlay.addEventListener('click', closeSidebar);

            // Initialize sidebar state: closed by default on first open
            function initSidebar() {
                const bp = getBreakpoint();
                if (bp === 'desktop') {
                    sidebar.classList.add('collapsed');
                    overlay.classList.remove('visible');
                } else {
                    sidebar.classList.add('collapsed');
                    overlay.classList.remove('visible');
                }
            }

            initSidebar();

            let lastBreakpoint = getBreakpoint();
            window.addEventListener('resize', function() {
                const bp = getBreakpoint();
                if (bp !== lastBreakpoint) {
                    lastBreakpoint = bp;
                    initSidebar();
                }
            });

            // ===== TEXTAREA AUTO RESIZE + SEND STATE =====
            function updateSendState() {
                if (sending) {
                    btnSend.disabled = false;
                    btnSend.classList.remove('active');
                    btnSend.classList.add('stopping');
                    btnSend.setAttribute('aria-label', 'Stop generating');
                    return;
                }
                btnSend.classList.remove('stopping');
                btnSend.setAttribute('aria-label', 'Send message');
                const hasText = chatInput.value.trim() !== '' || attachedFiles.length > 0 || !!ragDoc;
                btnSend.disabled = !hasText;
                btnSend.classList.toggle('active', hasText);
            }

            // While a reply streams the composer is locked: the model owns the
            // turn and the user either waits or presses Stop.
            function setComposerBusy(busy) {
                chatInput.readOnly = busy;
                chatInput.classList.toggle('is-busy', busy);
                chatInput.setAttribute('aria-busy', busy ? 'true' : 'false');
            }

            function stopGeneration() {
                if (!sending || !activeAbort) return;
                activeAbort.abort();
                chatInput.focus();
            }

            chatInput.addEventListener('input', function() {
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 200) + 'px';
                updateSendState();
            });

            // ===== CONVERSATIONS (IndexedDB is the source of truth) =====
            // The sidebar and the open thread render from the local session store,
            // so they work offline and with no account backend. Web storage is only
            // used to remember which conversation was open.
            function getActiveConversation() {
                for (let i = 0; i < conversations.length; i++) {
                    if (conversations[i].id === activeConversationId) return conversations[i];
                }
                return null;
            }

            function findSessionIndex(id) {
                for (let i = 0; i < sessions.length; i++) {
                    if (sessions[i] && sessions[i].id === id) return i;
                }
                return -1;
            }

            function findSession(id) {
                const i = findSessionIndex(id);
                return i >= 0 ? sessions[i] : null;
            }

            function latestSessionId() {
                let best = null;
                let bestTs = -1;
                sessions.forEach(function(s) {
                    if (!s || !s.id) return;
                    const ts = parseServerTime(s.updatedAt || s.createdAt);
                    if (ts > bestTs) { bestTs = ts; best = s.id; }
                });
                return best;
            }

            // Rebuilds the render-ready `conversations` array (newest first) from
            // the session store. Shape matches what renderHistory() expects.
            function syncConversationList() {
                conversations = sessions
                    .slice()
                    .sort(function(a, b) {
                        return parseServerTime(b && (b.updatedAt || b.createdAt))
                            - parseServerTime(a && (a.updatedAt || a.createdAt));
                    })
                    .map(function(s) {
                        return {
                            id: s.id,
                            title: s.title || 'Untitled',
                            model: s.model || null,
                            created_at: s.createdAt,
                            updated_at: s.updatedAt
                        };
                    });
            }

            /**
             * Re-reads the sidebar from IndexedDB.
             *
             * IndexedDB is the source of truth: the sidebar and the open thread
             * survive a refresh and work with no account backend. A local Express
             * server, when present, is imported as a best-effort extra; a missing
             * server must never blank the list (the "No conversations yet" bug).
             */
            async function refreshConversations() {
                await ensureMigrated();
                try {
                    sessions = (await loadSessions()).slice();
                } catch (e) {
                    sessions = [];
                }
                syncConversationList();
                renderHistory();
                // Fire-and-forget; reads a backend's list if one exists.
                importServerConversations();
            }

            // Imports conversations that exist only on a local Express backend.
            // On the static PWA this silently no-ops (GET /api/conversations 404s).
            let serverImportBusy = false;
            async function importServerConversations() {
                if (serverImportBusy) return;
                serverImportBusy = true;
                try {
                    const res = await fetch(API_BASE + '/conversations', { credentials: 'same-origin' });
                    if (!res.ok) return;
                    const data = await res.json();
                    const list = Array.isArray(data.conversations) ? data.conversations : [];
                    let changed = false;
                    for (let i = 0; i < list.length; i++) {
                        const c = list[i];
                        if (!c || !c.id || findSessionIndex(c.id) >= 0) continue;
                        const now = new Date().toISOString();
                        const session = {
                            id: c.id,
                            title: c.title || 'Untitled',
                            model: c.model || null,
                            createdAt: c.created_at || now,
                            updatedAt: c.updated_at || c.created_at || now,
                            messages: []
                        };
                        sessions.push(session);
                        await saveSession(session);
                        changed = true;
                    }
                    if (changed) { syncConversationList(); renderHistory(); }
                } catch (e) {
                    // No account backend (static PWA): local sessions stand alone.
                } finally {
                    serverImportBusy = false;
                }
            }

            /**
             * The API returns 'YYYY-MM-DD HH:MM:SS.SSS' in UTC. Without a zone
             * marker the Date constructor reads that as local time, which would
             * file an evening chat under tomorrow's group.
             */
            function parseServerTime(value) {
                if (!value) return Date.now();
                const iso = String(value).trim().replace(' ', 'T');
                const ms = Date.parse(/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z');
                return Number.isNaN(ms) ? Date.now() : ms;
            }

            function conversationGroup(ts) {
                const startOfDay = function(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
                const diff = Math.round((startOfDay(new Date()) - startOfDay(new Date(ts))) / 86400000);
                if (diff <= 0) return 'Today';
                if (diff === 1) return 'Yesterday';
                if (diff < 7) return 'Previous 7 days';
                return 'Older';
            }

            const EDIT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
            const DELETE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';

            function renderHistory() {
                if (!chatHistoryNav) return;
                chatHistoryNav.innerHTML = '';
                if (!conversations.length) {
                    const empty = document.createElement('div');
                    empty.className = 'history-empty';
                    empty.textContent = 'No conversations yet';
                    chatHistoryNav.appendChild(empty);
                    return;
                }
                const order = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];
                const buckets = { 'Today': [], 'Yesterday': [], 'Previous 7 days': [], 'Older': [] };
                conversations.forEach(function(c) {
                    buckets[conversationGroup(parseServerTime(c.updated_at || c.created_at))].push(c);
                });
                order.forEach(function(label) {
                    const items = buckets[label];
                    if (!items.length) return;
                    const section = document.createElement('div');
                    section.className = 'history-section';
                    const head = document.createElement('div');
                    head.className = 'history-label';
                    head.textContent = label;
                    section.appendChild(head);
                    items.forEach(function(convo) {
                        const item = document.createElement('div');
                        item.className = 'history-item' + (convo.id === activeConversationId ? ' active' : '');
                        item.setAttribute('data-id', convo.id);
                        const text = document.createElement('span');
                        text.className = 'history-item-text';
                        text.textContent = convo.title || 'Untitled';
                        const actions = document.createElement('div');
                        actions.className = 'history-item-actions';
                        const editBtn = document.createElement('button');
                        editBtn.className = 'btn-item-action';
                        editBtn.setAttribute('aria-label', 'Rename');
                        editBtn.title = 'Rename';
                        editBtn.innerHTML = EDIT_SVG;
                        const delBtn = document.createElement('button');
                        delBtn.className = 'btn-item-action';
                        delBtn.setAttribute('aria-label', 'Delete');
                        delBtn.title = 'Delete';
                        delBtn.innerHTML = DELETE_SVG;
                        actions.appendChild(editBtn);
                        actions.appendChild(delBtn);
                        item.appendChild(text);
                        item.appendChild(actions);
                        section.appendChild(item);
                    });
                    chatHistoryNav.appendChild(section);
                });
            }

            /**
             * Opens a conversation from IndexedDB. Falls back to the account
             * backend (local Express dev) for a thread not cached on this device.
             */
            async function loadConversation(id) {
                const local = findSession(id);
                if (local && Array.isArray(local.messages) && local.messages.length) {
                    renderSession(local);
                    return;
                }

                let data = null;
                try {
                    const res = await fetch(API_BASE + '/conversations/' + encodeURIComponent(id), {
                        credentials: 'same-origin'
                    });
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    data = await res.json();
                } catch (e) {
                    data = null;
                }

                if (data) {
                    const convo = data.conversation || {};
                    const messages = (Array.isArray(data.messages) ? data.messages : []).map(function(m) {
                        return {
                            id: m.id || newUuid(),
                            role: m.role === 'assistant' ? 'assistant' : 'user',
                            text: m.content || '',
                            createdAt: m.createdAt || m.created_at
                        };
                    });
                    const now = new Date().toISOString();
                    const session = {
                        id: id,
                        title: convo.title || (local && local.title) || 'Untitled',
                        model: convo.model || (local && local.model) || null,
                        createdAt: convo.created_at || (local && local.createdAt) || now,
                        updatedAt: convo.updated_at || (local && local.updatedAt) || now,
                        messages: messages
                    };
                    const idx = findSessionIndex(id);
                    if (idx >= 0) sessions[idx] = session; else sessions.push(session);
                    await saveSession(session);
                    syncConversationList();
                    renderSession(session);
                    return;
                }

                if (local) { renderSession(local); return; }
                // The list was stale (deleted in another tab, say): re-read it.
                await refreshConversations();
            }

            // Paints one session into the main view and mirrors it as the active
            // local thread, so a refresh restores exactly this conversation.
            function renderSession(session) {
                if (!session) return;
                const messages = Array.isArray(session.messages) ? session.messages : [];

                setActiveConversationId(session.id);
                setModelPicker(modelKeyFromLabel(session.model));

                messagesWrapper.innerHTML = '';
                messages.forEach(function(m) {
                    addMessage(m.role === 'assistant' ? 'assistant' : 'user', m.text || '', { image: m.image });
                });
                const nodes = messagesWrapper.querySelectorAll('.message');
                for (let i = 0; i < nodes.length && i < messages.length; i++) {
                    if (messages[i].id) nodes[i].__clientId = messages[i].id;
                    if (messages[i].createdAt) nodes[i].__createdAt = messages[i].createdAt;
                }

                chatHistory = messages.slice();
                saveHistory(chatHistory);

                // Seed the last turn so Regenerate works on a re-opened thread.
                for (let k = messages.length - 1; k >= 0; k--) {
                    if (messages[k].role !== 'assistant') {
                        lastTurn = { raw: messages[k].text || '', files: [] };
                        break;
                    }
                }

                if (messages.length) {
                    chatStarted = true;
                    welcomeScreen.style.display = 'none';
                    messagesWrapper.classList.add('visible');
                } else {
                    chatStarted = false;
                    welcomeScreen.style.display = '';
                    messagesWrapper.classList.remove('visible');
                }
                renderHistory();
                isPinnedToBottom = true;
                scrollToBottom(true);
                updateScrollFab();
            }

            function startNewChat() {
                // A new chat has no id until the first message: the session is
                // created then, so an untouched "New chat" leaves no stray entry.
                setActiveConversationId(null);
                chatStarted = false;
                welcomeScreen.style.display = '';
                messagesWrapper.classList.remove('visible');
                messagesWrapper.innerHTML = '';
                clearHistory();
                // Start a fresh cloud session so the next thread syncs separately.
                if (window.ChatBotSync) window.ChatBotSync.onNewChat();
                renderHistory();
                isPinnedToBottom = true;
                updateScrollFab();
                if (getBreakpoint() !== 'desktop') {
                    closeSidebar();
                }
                chatInput.focus();
            }

            // ===== LOCAL PERSISTENCE (IndexedDB) =====
            // Two stores: `chats` keeps the open thread under `current` (so a
            // refresh/offline reload never loses it), and `sessions` keeps every
            // conversation keyed by its id (the sidebar's source of truth).
            const IDB_NAME = 'ChatBotDB';
            const IDB_STORE = 'chats';
            const IDB_SESSIONS = 'sessions';
            const IDB_KEY = 'current';
            const IDB_VERSION = 2;
            let chatHistory = [];
            let dbPromise = null;
            let migrated = false;

            function initDB() {
                if (dbPromise) return dbPromise;
                dbPromise = new Promise(function(resolve) {
                    if (!('indexedDB' in window)) { resolve(null); return; }
                    let req;
                    try {
                        req = indexedDB.open(IDB_NAME, IDB_VERSION);
                    } catch (e) { resolve(null); return; }
                    req.onupgradeneeded = function() {
                        const db = req.result;
                        if (!db.objectStoreNames.contains(IDB_STORE)) {
                            db.createObjectStore(IDB_STORE);
                        }
                        if (!db.objectStoreNames.contains(IDB_SESSIONS)) {
                            db.createObjectStore(IDB_SESSIONS, { keyPath: 'id' });
                        }
                    };
                    req.onsuccess = function() { resolve(req.result); };
                    req.onerror = function() { resolve(null); };
                });
                return dbPromise;
            }

            function idbWrite(storeName, mutate) {
                return initDB().then(function(db) {
                    if (!db) return null;
                    return new Promise(function(resolve) {
                        let tx;
                        try {
                            tx = db.transaction(storeName, 'readwrite');
                            mutate(tx.objectStore(storeName));
                        } catch (e) { resolve(null); return; }
                        tx.oncomplete = function() { resolve(true); };
                        tx.onerror = function() { resolve(null); };
                        tx.onabort = function() { resolve(null); };
                    });
                });
            }

            function idbRead(storeName, key) {
                return initDB().then(function(db) {
                    if (!db) return null;
                    return new Promise(function(resolve) {
                        let tx;
                        try { tx = db.transaction(storeName, 'readonly'); } catch (e) { resolve(null); return; }
                        const req = tx.objectStore(storeName).get(key);
                        req.onsuccess = function() { resolve(req.result); };
                        req.onerror = function() { resolve(null); };
                    });
                });
            }

            function idbReadAll(storeName) {
                return initDB().then(function(db) {
                    if (!db) return [];
                    return new Promise(function(resolve) {
                        let tx;
                        try { tx = db.transaction(storeName, 'readonly'); } catch (e) { resolve([]); return; }
                        const req = tx.objectStore(storeName).getAll();
                        req.onsuccess = function() { resolve(Array.isArray(req.result) ? req.result : []); };
                        req.onerror = function() { resolve([]); };
                    });
                });
            }

            // The open thread, kept for backwards compatibility with data already
            // on disk and used to restore the main view on load.
            function saveHistory(messages) {
                return idbWrite(IDB_STORE, function(store) { store.put(messages || [], IDB_KEY); });
            }

            function clearHistory() {
                chatHistory = [];
                return idbWrite(IDB_STORE, function(store) { store.delete(IDB_KEY); });
            }

            function loadHistory() {
                return idbRead(IDB_STORE, IDB_KEY).then(function(result) {
                    return Array.isArray(result) ? result : [];
                });
            }

            // ===== MULTI-SESSION STORE =====
            // One record per conversation: { id, title, model, createdAt,
            // updatedAt, messages }. Many chats coexist instead of one thread
            // being overwritten every turn.
            function loadSessions() {
                return idbReadAll(IDB_SESSIONS);
            }

            function saveSession(session) {
                if (!session || !session.id) return Promise.resolve(false);
                return idbWrite(IDB_SESSIONS, function(store) { store.put(session); });
            }

            function deleteSession(id) {
                if (!id) return Promise.resolve(false);
                return idbWrite(IDB_SESSIONS, function(store) { store.delete(id); });
            }

            function clearSessions() {
                return idbWrite(IDB_SESSIONS, function(store) { store.clear(); });
            }

            // One-time: adopt a thread created before the session store existed, so
            // upgrading users don't lose their single local conversation.
            async function ensureMigrated() {
                if (migrated) return;
                migrated = true;
                try {
                    const existing = await loadSessions();
                    // `sessions` is the live list and is updated synchronously by
                    // upsertActiveSession, so this also catches a first message
                    // that raced ahead while we awaited IndexedDB.
                    if (existing.length || sessions.length) return;
                    const legacy = await loadHistory();
                    if (!legacy.length) return;
                    const now = new Date().toISOString();
                    const session = {
                        id: newUuid(),
                        title: deriveTitle(legacy),
                        model: currentModelKey,
                        createdAt: (legacy[0] && legacy[0].createdAt) || now,
                        updatedAt: (legacy[legacy.length - 1] && legacy[legacy.length - 1].createdAt) || now,
                        messages: legacy.slice()
                    };
                    await saveSession(session);
                } catch (e) {}
            }

            // Reflects the live thread (in DOM order) into memory + IndexedDB, and
            // rolls it into the active session so the sidebar stays in sync.
            // Regenerate and edit thus persist without special-casing.
            function persistHistory() {
                const nodes = messagesWrapper.querySelectorAll('.message');
                const out = [];
                for (let i = 0; i < nodes.length; i++) {
                    const el = nodes[i];
                    if (el.getAttribute('data-transient') === 'true') continue;
                    const text = typeof el.__sourceText === 'string' ? el.__sourceText : '';
                    const image = typeof el.__image === 'string' ? el.__image : '';
                    if (!text && !image) continue;
                    if (!el.__clientId) el.__clientId = newUuid();
                    if (!el.__createdAt) el.__createdAt = new Date().toISOString();
                    const record = {
                        id: el.__clientId,
                        role: el.classList.contains('user') ? 'user' : 'assistant',
                        text: text,
                        createdAt: el.__createdAt
                    };
                    if (image) record.image = image;
                    out.push(record);
                }
                chatHistory = out;
                saveHistory(chatHistory);
                upsertActiveSession(out);
                // Mirror to the cloud when signed in (debounced, never blocking).
                if (window.ChatBotSync) window.ChatBotSync.scheduleSync();
            }

            // Writes the live thread into its session record, creating it on the
            // first turn. No-op until a conversation id exists, so an empty new
            // chat never leaves a stray sidebar entry.
            function upsertActiveSession(messages) {
                if (!activeConversationId) return;
                const idx = findSessionIndex(activeConversationId);
                const prev = idx >= 0 ? sessions[idx] : null;
                const now = new Date().toISOString();
                // Keep a stored title (a user rename or a server-provided one) and
                // only derive one for a brand-new / still-placeholder session.
                const prevTitle = prev && prev.title;
                const title = (prevTitle && prevTitle !== 'Untitled')
                    ? prevTitle
                    : (deriveTitle(messages) || 'Untitled');
                const session = {
                    id: activeConversationId,
                    title: title,
                    model: currentModelKey,
                    createdAt: (prev && prev.createdAt) || (messages[0] && messages[0].createdAt) || now,
                    updatedAt: now,
                    messages: messages.slice()
                };
                if (idx >= 0) sessions[idx] = session; else sessions.push(session);
                syncConversationList();
                saveSession(session);
                renderHistory();
            }

            // Rebuilds the chat from IndexedDB on first load. No API call here.
            async function restoreLocalHistory() {
                if (messagesWrapper.children.length > 0) return;
                const saved = await loadHistory();
                if (!saved.length) return;
                chatHistory = saved.slice();

                // Re-adopt the conversation this thread belongs to, so the next
                // turn appends to it instead of forking a new session.
                let id = storedActiveConversationId();
                if (!id || findSessionIndex(id) < 0) id = latestSessionId();
                if (!id) id = newUuid();
                setActiveConversationId(id);

                saved.forEach(function(m) {
                    const bubble = addMessage(m.role === 'user' ? 'user' : 'assistant', m.text || '', { image: m.image });
                    if (bubble && bubble.element) {
                        if (m.id) bubble.element.__clientId = m.id;
                        if (m.createdAt) bubble.element.__createdAt = m.createdAt;
                    }
                });
                chatStarted = true;
                welcomeScreen.style.display = 'none';
                messagesWrapper.classList.add('visible');
                for (let k = saved.length - 1; k >= 0; k--) {
                    if (saved[k].role === 'user') {
                        lastTurn = { raw: saved[k].text || '', files: [] };
                        break;
                    }
                }
                // Keep this thread's session record present and current.
                upsertActiveSession(saved);
                renderHistory();
                isPinnedToBottom = true;
                scrollToBottom(true);
                updateScrollFab();
            }

            // ===== CLOUD SYNC (Supabase) — additive, optional =====
            // IndexedDB stays the single source of truth for the UI. When the user
            // is signed in, the local thread is mirrored to Supabase in the
            // background and can be pulled back onto a fresh device. Every call is
            // guarded, so an unconfigured / offline Supabase never breaks the app.
            //
            // Setup: paste your project URL + anon key below (or inject
            // window.CHATBOT_SUPABASE_URL / window.CHATBOT_SUPABASE_ANON_KEY),
            // then run supabase/schema.sql in the Supabase SQL editor.
            const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
            const SUPABASE_ANON_KEY = 'YOUR-PUBLIC-ANON-KEY';
            const SUPA_URL = window.CHATBOT_SUPABASE_URL || SUPABASE_URL;
            const SUPA_KEY = window.CHATBOT_SUPABASE_ANON_KEY || SUPABASE_ANON_KEY;
            const CLOUD_SESSION_LS_KEY = 'chatbotai_cloud_session_id';

            let supaClient = null;
            let supaUser = null;
            let supaReady = false;
            let syncTimer = null;

            function newUuid() {
                try {
                    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
                        return window.crypto.randomUUID();
                    }
                } catch (e) {}
                return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                    const r = (Math.random() * 16) | 0;
                    const v = c === 'x' ? r : ((r & 0x3) | 0x8);
                    return v.toString(16);
                });
            }

            function cloudConfigured() {
                return typeof SUPA_URL === 'string'
                    && SUPA_URL.indexOf('http') === 0
                    && SUPA_URL.indexOf('YOUR-PROJECT') === -1
                    && typeof SUPA_KEY === 'string'
                    && SUPA_KEY.length > 20
                    && SUPA_KEY.indexOf('YOUR-PUBLIC') === -1;
            }

            function initSupabase() {
                if (supaClient) return supaClient;
                if (!cloudConfigured()) return null;
                const lib = window.supabase;
                if (!lib || typeof lib.createClient !== 'function') return null;
                try {
                    supaClient = lib.createClient(SUPA_URL, SUPA_KEY, {
                        auth: {
                            persistSession: true,
                            autoRefreshToken: true,
                            detectSessionInUrl: true
                        }
                    });
                } catch (e) {
                    supaClient = null;
                }
                return supaClient;
            }

            function peekCloudSessionId() {
                try { return localStorage.getItem(CLOUD_SESSION_LS_KEY); } catch (e) { return null; }
            }

            function getCloudSessionId() {
                let id = peekCloudSessionId();
                if (!id) {
                    id = newUuid();
                    try { localStorage.setItem(CLOUD_SESSION_LS_KEY, id); } catch (e) {}
                }
                return id;
            }

            function resetCloudSession() {
                const id = newUuid();
                try { localStorage.setItem(CLOUD_SESSION_LS_KEY, id); } catch (e) {}
                return id;
            }

            function deriveTitle(messages) {
                for (let i = 0; i < messages.length; i++) {
                    if (messages[i].role === 'user' && messages[i].text) {
                        const t = String(messages[i].text).replace(/\s+/g, ' ').trim();
                        return t.length > 60 ? t.slice(0, 60) + '…' : t;
                    }
                }
                return 'Untitled';
            }

            function buildSessionData(messages) {
                const base = Date.now();
                return {
                    id: getCloudSessionId(),
                    title: deriveTitle(messages),
                    messages: messages.map(function(m, i) {
                        return {
                            id: m.id || newUuid(),
                            role: (m.role === 'user') ? 'user' : 'assistant',
                            content: m.text || '',
                            rawContent: (typeof m.raw === 'string') ? m.raw : null,
                            createdAt: m.createdAt || new Date(base + i).toISOString()
                        };
                    })
                };
            }

            // Pushes a local thread to Supabase. Idempotent (upsert by UUID), so it
            // is safe to call repeatedly. Never throws into the caller.
            async function syncToCloud(sessionData) {
                const client = initSupabase();
                if (!client || !supaUser || !sessionData) return false;
                const messages = sessionData.messages || [];
                if (!messages.length) return false;
                try {
                    const sessionRes = await client.from('chat_sessions').upsert({
                        id: sessionData.id,
                        user_id: supaUser.id,
                        title: sessionData.title || 'Untitled',
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'id' });
                    if (sessionRes && sessionRes.error) throw sessionRes.error;

                    const rows = messages.map(function(m) {
                        return {
                            id: m.id,
                            session_id: sessionData.id,
                            role: m.role,
                            content: m.content,
                            raw_content: m.rawContent,
                            created_at: m.createdAt
                        };
                    });
                    const msgRes = await client.from('chat_messages').upsert(rows, { onConflict: 'id' });
                    if (msgRes && msgRes.error) throw msgRes.error;

                    setCloudStatus('Synced · ' + messages.length + ' message' + (messages.length === 1 ? '' : 's'));
                    return true;
                } catch (e) {
                    setCloudStatus('Sync failed — will retry');
                    return false;
                }
            }

            function scheduleSync() {
                if (!supaUser) return;
                if (syncTimer) clearTimeout(syncTimer);
                syncTimer = setTimeout(function() {
                    syncTimer = null;
                    syncToCloud(buildSessionData(chatHistory.slice()));
                }, 1200);
            }

            function renderCloudHistory(list) {
                messagesWrapper.innerHTML = '';
                messagesWrapper.classList.add('visible');
                welcomeScreen.style.display = 'none';
                chatStarted = true;
                list.forEach(function(m) {
                    const bubble = addMessage(m.role === 'user' ? 'user' : 'assistant', m.text || '');
                    if (bubble && bubble.element) {
                        if (m.id) bubble.element.__clientId = m.id;
                        if (m.createdAt) bubble.element.__createdAt = m.createdAt;
                    }
                });
                for (let k = list.length - 1; k >= 0; k--) {
                    if (list[k].role === 'user') {
                        lastTurn = { raw: list[k].text || '', files: [] };
                        break;
                    }
                }
                renderHistory();
                isPinnedToBottom = true;
                scrollToBottom(true);
                updateScrollFab();
            }

            // Pulls the most recent session for the signed-in user and mirrors it
            // into IndexedDB (same key/shape the UI already reads).
            async function fetchFromCloud() {
                const client = initSupabase();
                if (!client || !supaUser) return false;
                try {
                    const sRes = await client.from('chat_sessions')
                        .select('*')
                        .order('updated_at', { ascending: false })
                        .limit(1);
                    if (sRes && sRes.error) throw sRes.error;
                    const session = sRes && sRes.data && sRes.data[0];
                    if (!session) { setCloudStatus('No cloud chats yet'); return false; }

                    const mRes = await client.from('chat_messages')
                        .select('*')
                        .eq('session_id', session.id)
                        .order('created_at', { ascending: true });
                    if (mRes && mRes.error) throw mRes.error;
                    const rows = (mRes && mRes.data) || [];
                    const messages = rows.map(function(r) {
                        return {
                            id: r.id,
                            role: r.role === 'user' ? 'user' : 'assistant',
                            text: r.content || '',
                            raw: r.raw_content || undefined,
                            createdAt: r.created_at
                        };
                    });

                    chatHistory = messages.slice();
                    await saveHistory(chatHistory);
                    try { localStorage.setItem(CLOUD_SESSION_LS_KEY, session.id); } catch (e) {}
                    renderCloudHistory(messages);
                    setCloudStatus('Restored · ' + messages.length + ' message' + (messages.length === 1 ? '' : 's'));
                    return true;
                } catch (e) {
                    setCloudStatus('Restore failed');
                    return false;
                }
            }

            function setCloudStatus(text) {
                const el = document.getElementById('cloudSyncStatus');
                if (el && typeof text === 'string') el.textContent = text;
            }

            function updateCloudUI() {
                const login = document.getElementById('btnGoogleLogin');
                const now = document.getElementById('btnCloudSyncNow');
                const logout = document.getElementById('btnGoogleLogout');
                const signedIn = !!supaUser;
                if (login) login.hidden = signedIn;
                if (now) now.hidden = !signedIn;
                if (logout) logout.hidden = !signedIn;
                if (signedIn) {
                    setCloudStatus('Signed in as ' + (supaUser.email || supaUser.id));
                } else {
                    setCloudStatus('Not connected — chats stay on this device.');
                }
            }

            function loginWithGoogle() {
                const client = initSupabase();
                if (!client) { setCloudStatus('Cloud not configured yet.'); return; }
                try {
                    const redirectTo = window.location.origin + window.location.pathname;
                    client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo } });
                } catch (e) {}
            }

            function logoutCloud() {
                const client = initSupabase();
                if (!client) return;
                try { client.auth.signOut(); } catch (e) {}
            }

            async function handleSignedIn() {
                // New device / first login: adopt the cloud thread if local is empty.
                const local = await loadHistory();
                if (!local.length) {
                    await fetchFromCloud();
                } else if (!peekCloudSessionId()) {
                    scheduleSync();
                }
            }

            function initCloudSync() {
                if (supaReady) return;
                supaReady = true;

                const login = document.getElementById('btnGoogleLogin');
                const now = document.getElementById('btnCloudSyncNow');
                const logout = document.getElementById('btnGoogleLogout');
                if (login) login.addEventListener('click', loginWithGoogle);
                if (logout) logout.addEventListener('click', logoutCloud);
                if (now) now.addEventListener('click', async function() {
                    const local = await loadHistory();
                    if (local.length) {
                        setCloudStatus('Syncing…');
                        await syncToCloud(buildSessionData(local));
                    } else {
                        await fetchFromCloud();
                    }
                });

                const client = initSupabase();
                updateCloudUI();
                if (!client) return;

                client.auth.getSession().then(function(res) {
                    const session = res && res.data ? res.data.session : null;
                    supaUser = session && session.user ? session.user : null;
                    updateCloudUI();
                    if (supaUser) handleSignedIn();
                }).catch(function() {});

                client.auth.onAuthStateChange(function(event, session) {
                    supaUser = session && session.user ? session.user : null;
                    updateCloudUI();
                    // Deferred: awaiting inside this callback can deadlock the auth lock.
                    setTimeout(function() {
                        if (event === 'SIGNED_IN') handleSignedIn();
                    }, 0);
                });
            }

            // Public bridge (also used by the test harness).
            window.ChatBotSync = {
                init: initCloudSync,
                scheduleSync: scheduleSync,
                syncToCloud: syncToCloud,
                fetchFromCloud: fetchFromCloud,
                buildSessionData: buildSessionData,
                onNewChat: resetCloudSession,
                isSignedIn: function() { return !!supaUser; },
                configured: cloudConfigured
            };

            initCloudSync();

            async function deleteConversation(id) {
                if (!id) return;
                const wasActive = activeConversationId === id;
                // Remove locally first: this is what makes delete instant and
                // reliable with no account backend.
                await deleteSession(id);
                sessions = sessions.filter(function(s) { return s && s.id !== id; });
                syncConversationList();
                if (wasActive) {
                    startNewChat();
                } else {
                    renderHistory();
                }
                // Best-effort server mirror (ignored when there is no backend).
                try {
                    await fetch(API_BASE + '/conversations/' + encodeURIComponent(id), {
                        method: 'DELETE',
                        credentials: 'same-origin'
                    });
                } catch (e) {}
            }

            function startRename(item, id) {
                let convo = null;
                for (let i = 0; i < conversations.length; i++) {
                    if (conversations[i].id === id) convo = conversations[i];
                }
                const textSpan = item.querySelector('.history-item-text');
                if (!convo || !textSpan || item.querySelector('.history-rename-input')) return;
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'history-rename-input';
                input.value = convo.title || '';
                input.setAttribute('aria-label', 'Rename conversation');
                let done = false;
                async function commit(save) {
                    if (done) return;
                    done = true;
                    const title = input.value.trim();
                    if (save && title && title !== convo.title) {
                        // Local-first: rename in the session store, then mirror.
                        const idx = findSessionIndex(id);
                        if (idx >= 0) {
                            sessions[idx].title = title;
                            sessions[idx].updatedAt = new Date().toISOString();
                            await saveSession(sessions[idx]);
                            syncConversationList();
                        }
                        try {
                            await fetch(API_BASE + '/conversations/' + encodeURIComponent(id), {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                credentials: 'same-origin',
                                body: JSON.stringify({ title: title })
                            });
                        } catch (e) {}
                    }
                    renderHistory();
                }
                input.addEventListener('click', function(ev) { ev.stopPropagation(); });
                input.addEventListener('keydown', function(ev) {
                    ev.stopPropagation();
                    if (ev.key === 'Enter') commit(true);
                    else if (ev.key === 'Escape') commit(false);
                });
                input.addEventListener('blur', function() { commit(true); });
                textSpan.textContent = '';
                textSpan.appendChild(input);
                input.focus();
                input.select();
            }

            // ===== API KEY REQUIRED POPUP =====
            const keyAlertOverlay = document.getElementById('keyAlertOverlay');
            const keyAlertDesc = document.getElementById('keyAlertDesc');
            const btnKeyAlertSettings = document.getElementById('btnKeyAlertSettings');
            const btnKeyAlertClose = document.getElementById('btnKeyAlertClose');

            function closeKeyAlert() {
                if (keyAlertOverlay) keyAlertOverlay.hidden = true;
            }

            /**
             * Names the model the way the picker does.
             *
             * The server reports a missing key against the label it was sent
             * ("GPT-4o"), and the key panel calls it by its internal key, so
             * this accepts either.
             */
            function showKeyAlert(model) {
                const label = modelLabelFor(model);
                if (keyAlertDesc) {
                    keyAlertDesc.textContent = label + ' needs an API key before it can be used. Add it in Settings → API Key, then try again.';
                }
                if (keyAlertOverlay) keyAlertOverlay.hidden = false;
            }

            if (btnKeyAlertClose) {
                btnKeyAlertClose.addEventListener('click', closeKeyAlert);
            }
            if (keyAlertOverlay) {
                keyAlertOverlay.addEventListener('click', function(e) {
                    if (e.target === keyAlertOverlay) closeKeyAlert();
                });
            }
            if (btnKeyAlertSettings) {
                btnKeyAlertSettings.addEventListener('click', function() {
                    closeKeyAlert();
                    if (window.ChatBotSettings && typeof window.ChatBotSettings.openPanel === 'function') {
                        window.ChatBotSettings.openPanel('api-key');
                    }
                });
            }
            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape' && keyAlertOverlay && !keyAlertOverlay.hidden) {
                    closeKeyAlert();
                }
            });

            // ===== SEND MESSAGE =====
            // Runs one assistant turn: paints the streaming bubble, honours Stop
            // and reports errors. Shared by send, regenerate and message edit.
            async function runAssistant(raw, filesSnapshot, ragText) {
                // The assistant bubble is created on the first delta, so a turn
                // that never produces one leaves no empty shell behind.
                let bubble = null;
                function ensureBubble() {
                    if (!bubble) bubble = addMessage('assistant', '');
                    return bubble;
                }

                sending = true;
                activeAbort = new AbortController();
                const signal = activeAbort.signal;
                updateSendState();
                setComposerBusy(true);
                typingIndicator.classList.add('visible');
                isPinnedToBottom = true;
                scrollToBottom(true);

                const typer = createTypewriter(function(partial) {
                    ensureBubble().setText(partial + '\u258d');
                });

                try {
                    const turn = await callAssistant(currentModelKey, raw, filesSnapshot, function(chunk) {
                        typingIndicator.classList.remove('visible');
                        typer.push(chunk);
                        scrollToBottom();
                    }, signal, ragText);
                    typer.finish();
                    // Adopt the server's id when it created the thread; with a
                    // stateless backend (no DB) mint a local id instead, so the
                    // turn lands in a session and shows up in the sidebar.
                    setActiveConversationId(turn.conversationId || activeConversationId || newUuid());
                } catch (error) {
                    typer.finish();
                    if (error && error.name === 'AbortError') {
                        // Keep whatever streamed before the user hit Stop.
                        if (bubble) bubble.setText(bubble.getText() + '\n\n— stopped by you.');
                    } else {
                        const message = (error && error.message) ? error.message : 'request failed.';
                        if (error && error.code === 'missing_api_key') {
                            // The server refused before writing anything, so point
                            // at the setting that fixes it and keep the alert as the
                            // only feedback.
                            showKeyAlert(error.model);
                        } else if (error && error.partial) {
                            // Keep the text that did arrive, and say why it stopped.
                            ensureBubble().setText(error.partial + '\n\n— the reply stopped early: ' + message);
                        } else {
                            ensureBubble().setText('Sorry — ' + message);
                        }
                    }
                } finally {
                    typingIndicator.classList.remove('visible');
                    sending = false;
                    activeAbort = null;
                    setComposerBusy(false);
                    updateSendState();
                    // Persist the finished turn locally (survives refresh/offline).
                    persistHistory();
                    // Auto-focus: cursor is ready for the next prompt the moment
                    // the reply finishes (or is stopped) — no manual click needed.
                    chatInput.focus();
                }

                // Titles and ordering belong to the server, so re-read them.
                await refreshConversations();
                scrollToBottom(true);
            }

            // Re-runs the most recent user turn without adding a new user bubble.
            async function regenerate() {
                if (sending) return;
                if (lastTurn.image && lastTurn.raw) {
                    await generateImageTurn(lastTurn.raw);
                    return;
                }
                if (!lastTurn.raw && !(lastTurn.files && lastTurn.files.length)) return;
                if (!modelHasKey(currentModelKey)) {
                    showKeyAlert(currentModelKey);
                    return;
                }
                if (!chatStarted) {
                    chatStarted = true;
                    welcomeScreen.style.display = 'none';
                    messagesWrapper.classList.add('visible');
                }
                await runAssistant(lastTurn.raw, lastTurn.files, lastTurn.rag);
            }

            async function sendMessage(text) {
                if (sending) return;
                const raw = (text || '').trim();
                const hasFiles = attachedFiles.length > 0 || !!ragDoc;
                if (!raw && !hasFiles) return;

                // Fast path: the key panel already knows this model has no key,
                // so don't spend a round trip proving it. The server re-checks
                // and is the real enforcement.
                if (!modelHasKey(currentModelKey)) {
                    showKeyAlert(currentModelKey);
                    return;
                }

                if (!chatStarted) {
                    chatStarted = true;
                    welcomeScreen.style.display = 'none';
                    messagesWrapper.classList.add('visible');
                }

                // An image turn skips the streaming chat path entirely.
                const imagePrompt = imagePromptFrom(raw);
                if (imagePrompt !== null) {
                    attachedFiles.length = 0;
                    clearRagDoc();
                    const preview = document.getElementById('filePreviewArea');
                    if (preview) {
                        preview.innerHTML = '';
                        preview.hidden = true;
                    }
                    chatInput.value = '';
                    chatInput.style.height = 'auto';
                    if (imagePrompt !== '') await generateImageTurn(imagePrompt);
                    return;
                }

                // The backend accepts no file bytes, so the turn carries the
                // attachment names and nothing else.
                const filesSnapshot = attachedFiles.map(function(f) {
                    return { name: f.name, type: f.type };
                });
                const displayText = buildUserText(raw, filesSnapshot);
                // The RAG context is consumed by this one turn: snapshot the text
                // (so regenerate can reuse it) and clear the indicator right away.
                const ragSnapshot = ragDoc ? ragDoc.text : '';
                attachedFiles.length = 0;
                clearRagDoc();
                const filePreviewArea = document.getElementById('filePreviewArea');
                if (filePreviewArea) {
                    filePreviewArea.innerHTML = '';
                    filePreviewArea.hidden = true;
                }

                addMessage('user', displayText);
                persistHistory();
                chatInput.value = '';
                chatInput.style.height = 'auto';
                lastTurn = { raw: raw, files: filesSnapshot, rag: ragSnapshot };

                await runAssistant(raw, filesSnapshot, ragSnapshot);
            }

            // An image turn is requested either by selecting the Image model or
            // by typing "/image <prompt>". Returns the prompt, or null when this
            // is a normal chat turn.
            function imagePromptFrom(raw) {
                const match = /^\/image\b\s*([\s\S]*)$/i.exec(raw);
                if (match) return (match[1] || '').trim();
                if (currentModelKey === 'image') return raw.trim();
                return null;
            }

            // Generates one image and paints it into an assistant bubble. Unlike
            // chat this is not streamed: POST /api/image answers with JSON.
            async function generateImageTurn(prompt) {
                const backend = imageBackend();
                if (!backend) {
                    showKeyAlert('image');
                    return;
                }
                // The prompt is a real user turn, so the conversation exists even
                // if generation later fails.
                setActiveConversationId(activeConversationId || newUuid());

                if (!chatStarted) {
                    chatStarted = true;
                    welcomeScreen.style.display = 'none';
                    messagesWrapper.classList.add('visible');
                }

                addMessage('user', prompt);
                persistHistory();
                lastTurn = { raw: prompt, files: [], image: true };

                sending = true;
                activeAbort = new AbortController();
                const signal = activeAbort.signal;
                updateSendState();
                setComposerBusy(true);
                typingIndicator.classList.add('visible');
                isPinnedToBottom = true;
                scrollToBottom(true);

                const bubble = addMessage('assistant', 'Generating image…');

                try {
                    const res = await fetch(API_BASE + '/image', {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Provider-Key': backend.key
                        },
                        body: JSON.stringify({ prompt: prompt, provider: backend.provider }),
                        signal: signal
                    });
                    if (!res.ok) throw await backendError(res);
                    const data = await res.json();
                    const url = data && data.image ? data.image.dataUrl : '';
                    if (!url) throw new Error('The image service returned no image.');
                    bubble.setImage(url, prompt);
                } catch (error) {
                    if (error && error.name === 'AbortError') {
                        bubble.setText('— stopped by you.');
                    } else if (error && error.code === 'missing_api_key') {
                        bubble.element.remove();
                        showKeyAlert(error.model || 'image');
                    } else {
                        const message = (error && error.message) ? error.message : 'request failed.';
                        bubble.setText('Sorry — ' + message);
                    }
                } finally {
                    typingIndicator.classList.remove('visible');
                    sending = false;
                    activeAbort = null;
                    setComposerBusy(false);
                    updateSendState();
                    persistHistory();
                    chatInput.focus();
                }

                await refreshConversations();
                scrollToBottom(true);
            }

            function addMessage(role, text, options) {
                const msg = document.createElement('div');
                msg.className = 'message ' + role;
                const image = (options && options.image) ? String(options.image) : '';

                const avatarIcon = role === 'user'
                    ? 'U'
                    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

                const senderName = role === 'user' ? 'You' : 'ChatBot AI';
                const formattedText = formatText(text);

                const copyAction = '<button class="btn-msg-action" type="button" data-action="copy" aria-label="Copy">'
                    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</button>';
                const regenerateAction = '<button class="btn-msg-action" type="button" data-action="regenerate" aria-label="Regenerate">'
                    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg> Regenerate</button>';
                const likeAction = '<button class="btn-msg-action" type="button" data-action="like" aria-label="Good response">'
                    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88"/></svg></button>';
                const dislikeAction = '<button class="btn-msg-action" type="button" data-action="dislike" aria-label="Bad response">'
                    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88"/></svg></button>';
                const editAction = '<button class="btn-msg-action" type="button" data-action="edit" aria-label="Edit message">'
                    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg> Edit</button>';

                const actions = role === 'user'
                    ? copyAction + editAction
                    : copyAction + regenerateAction + likeAction + dislikeAction;

                msg.innerHTML = '<div class="message-content">'
                    + '<div class="message-avatar">' + avatarIcon + '</div>'
                    + '<div class="message-body">'
                    + '<div class="message-sender">' + senderName + '</div>'
                    + '<div class="message-text">' + formattedText + '</div>'
                    + '<div class="message-actions">' + actions + '</div>'
                    + '</div></div>';

                messagesWrapper.appendChild(msg);

                // Streaming replies grow after insertion, so keep the source text
                // here and re-render on each update. __sourceText mirrors it for
                // the IndexedDB persistence layer.
                let currentText = text;
                msg.__sourceText = currentText;
                // Stable identity + timestamp for cloud sync (additive; IndexedDB
                // remains the single source of truth for the UI).
                if (!msg.__clientId) msg.__clientId = newUuid();
                if (!msg.__createdAt) msg.__createdAt = new Date().toISOString();
                const textNode = msg.querySelector('.message-text');

                if (image) {
                    const img = document.createElement('img');
                    img.className = 'message-image';
                    img.src = image;
                    img.alt = (String(text || '').trim() || 'Generated image').slice(0, 120);
                    img.loading = 'lazy';
                    msg.querySelector('.message-body').insertBefore(img, msg.querySelector('.message-actions'));
                    msg.__image = image;
                }

                // Copy button
                const copyBtn = msg.querySelector('[data-action="copy"]');
                copyBtn.addEventListener('click', function() {
                    navigator.clipboard.writeText(currentText).then(function() {
                        copyBtn.classList.add('active');
                        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
                        setTimeout(function() {
                            copyBtn.classList.remove('active');
                            copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
                        }, 2000);
                    });
                });

                // Thumbs up / down are mutually exclusive toggles.
                const likeBtn = msg.querySelector('[data-action="like"]');
                const dislikeBtn = msg.querySelector('[data-action="dislike"]');
                if (likeBtn) likeBtn.addEventListener('click', function() {
                    likeBtn.classList.toggle('active');
                    if (dislikeBtn) dislikeBtn.classList.remove('active');
                });
                if (dislikeBtn) dislikeBtn.addEventListener('click', function() {
                    dislikeBtn.classList.toggle('active');
                    if (likeBtn) likeBtn.classList.remove('active');
                });

                // Regenerate replays the last user turn (assistant messages only).
                const regenBtn = msg.querySelector('[data-action="regenerate"]');
                if (regenBtn) regenBtn.addEventListener('click', function() { regenerate(); });

                // Edit rewrites a user message and re-runs the turn.
                const editBtn = msg.querySelector('[data-action="edit"]');
                if (editBtn) editBtn.addEventListener('click', function() {
                    enterEditMode(msg, textNode, function(nextText) {
                        currentText = nextText;
                        textNode.innerHTML = formatText(currentText);
                        lastTurn = { raw: nextText, files: [] };
                        runAssistant(nextText, []);
                    });
                });

                return {
                    element: msg,
                    append: function(chunk) {
                        currentText += chunk;
                        msg.__sourceText = currentText;
                        textNode.innerHTML = formatText(currentText);
                    },
                    setText: function(next) {
                        currentText = next;
                        msg.__sourceText = currentText;
                        const old = msg.querySelector('.message-image');
                        if (old) old.remove();
                        msg.__image = '';
                        textNode.innerHTML = formatText(currentText);
                    },
                    setImage: function(url, alt) {
                        currentText = '';
                        msg.__sourceText = '';
                        textNode.innerHTML = '';
                        let img = msg.querySelector('.message-image');
                        if (!img) {
                            img = document.createElement('img');
                            img.className = 'message-image';
                            img.loading = 'lazy';
                            msg.querySelector('.message-body').insertBefore(img, msg.querySelector('.message-actions'));
                        }
                        img.src = url;
                        img.alt = (String(alt || '').trim() || 'Generated image').slice(0, 120);
                        msg.__image = url;
                    },
                    getText: function() {
                        return currentText;
                    }
                };
            }

            // Inline editor for a user message. Save rewrites the bubble and
            // re-runs the assistant; Escape / Cancel restores the original.
            function enterEditMode(msg, textNode, onSave) {
                if (msg.querySelector('.edit-composer')) return;
                const body = msg.querySelector('.message-body');
                const actionsRow = msg.querySelector('.message-actions');
                const source = textNode.textContent;

                const wrap = document.createElement('div');
                wrap.className = 'edit-composer';

                const ta = document.createElement('textarea');
                ta.className = 'edit-textarea';
                ta.value = source;
                ta.rows = Math.min(12, Math.max(2, Math.ceil(source.length / 60)));

                const row = document.createElement('div');
                row.className = 'edit-actions';
                const saveBtn = document.createElement('button');
                saveBtn.type = 'button';
                saveBtn.className = 'btn primary';
                saveBtn.textContent = 'Save & Submit';
                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.className = 'btn';
                cancelBtn.textContent = 'Cancel';
                row.appendChild(saveBtn);
                row.appendChild(cancelBtn);
                wrap.appendChild(ta);
                wrap.appendChild(row);

                textNode.style.display = 'none';
                body.insertBefore(wrap, actionsRow);

                function close() {
                    wrap.remove();
                    textNode.style.display = '';
                }
                cancelBtn.addEventListener('click', close);
                saveBtn.addEventListener('click', function() {
                    const next = ta.value.trim();
                    if (!next) { ta.focus(); return; }
                    close();
                    onSave(next);
                });
                ta.addEventListener('keydown', function(e) {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        close();
                    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        saveBtn.click();
                    }
                });
                ta.focus();
                ta.setSelectionRange(ta.value.length, ta.value.length);
            }

            // ===== MARKDOWN =====
            function escapeHtml(s) {
                return String(s)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
            }

            // Defense-in-depth for model-generated content: every string that
            // reaches .innerHTML passes through here. DOMPurify strips scripts,
            // event handlers and javascript: URLs while preserving the safe
            // markup our Markdown renderer emits (classes, data-* hooks, links).
            function sanitizeHtml(html) {
                if (typeof window !== 'undefined' && window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
                    return window.DOMPurify.sanitize(html, {
                        ADD_ATTR: ['target', 'rel', 'data-code-copy', 'data-action']
                    });
                }
                return html;
            }

            // Lightweight syntax tint for fenced code. Operates on already
            // escaped text and matches each token once via one alternation, so
            // a character is never wrapped twice.
            function highlightCode(code, lang) {
                const escaped = escapeHtml(code);
                const known = /^(js|javascript|ts|typescript|jsx|tsx|python|py|java|c|cpp|cs|csharp|go|rust|rb|ruby|php|sh|bash|shell|sql|json|html|xml|css|yaml|yml)$/i.test(lang || '');
                if (!known) return escaped;
                const token = /(?:\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|(\b(?:function|return|const|let|var|if|else|elif|for|while|do|done|fi|then|class|new|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|this|super|extends|def|lambda|None|True|False|print|self|and|or|not|in|is|package|public|private|protected|static|void|int|float|double|struct|impl|fn|pub|use|mut|match|select|where|insert|update|delete|end)\b)/g;
                return escaped.replace(token, function(m, num, kw) {
                    if (num) return '<span class="tok-num">' + num + '</span>';
                    if (kw) return '<span class="tok-key">' + kw + '</span>';
                    if (m.charAt(0) === '/' || m.charAt(0) === '#') return '<span class="tok-com">' + m + '</span>';
                    return '<span class="tok-str">' + m + '</span>';
                });
            }

            const CODE_COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

            function buildCodeBlock(block) {
                const rawLang = block.lang ? block.lang : '';
                const langClass = rawLang ? escapeHtml(rawLang.toLowerCase()) : 'plaintext';
                const label = rawLang ? escapeHtml(rawLang) : 'code';
                return '<div class="code-block">'
                    + '<div class="code-block-header">'
                    + '<span class="code-lang">' + label + '</span>'
                    + '<button class="btn-code-copy" type="button" data-code-copy aria-label="Copy code">'
                    + CODE_COPY_ICON + '<span>Copy</span>'
                    + '</button>'
                    + '</div>'
                    + '<pre><code class="language-' + langClass + '">' + highlightCode(block.code, rawLang) + '</code></pre>'
                    + '</div>';
            }

            function inlineMarkdown(s) {
                const codes = [];
                // Pull inline code out first so emphasis rules cannot touch its body.
                let t = s.replace(/`([^`]+)`/g, function(_, c) {
                    codes.push(c);
                    return '\u0002IC' + (codes.length - 1) + '\u0002';
                });
                t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function(_, label, href) {
                    const safe = href.replace(/["']/g, '');
                    return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
                });
                t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
                t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
                t = t.replace(/~~(.+?)~~/g, '<del>$1</del>');
                t = t.replace(/\u0002IC(\d+)\u0002/g, function(_, n) {
                    return '<code>' + codes[Number(n)] + '</code>';
                });
                return t;
            }

            function splitTableRow(line) {
                let s = line.trim();
                if (s.charAt(0) === '|') s = s.slice(1);
                if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
                return s.split('|');
            }

            function isTableStart(lines, idx) {
                if (idx + 1 >= lines.length) return false;
                if (lines[idx].indexOf('|') === -1) return false;
                const sep = splitTableRow(lines[idx + 1]);
                if (!sep.length) return false;
                for (let k = 0; k < sep.length; k++) {
                    if (!/^:?-{1,}:?$/.test(sep[k].trim())) return false;
                }
                return true;
            }

            function isBlockStart(line) {
                return /^\u0001CODE\d+\u0001$/.test(line)
                    || /^(#{1,6})\s+/.test(line)
                    || /^\s*([-*_])\s*(\1\s*){2,}$/.test(line)
                    || /^\s*&gt;\s?/.test(line)
                    || /^\s*[-*+]\s+/.test(line)
                    || /^\s*\d+[.)]\s+/.test(line);
            }

            function formatText(text) {
                if (text == null) return '';
                const src = String(text);

                // Fenced code blocks are lifted out before escaping so their
                // bodies stay verbatim; they return as one-line placeholders.
                const codeBlocks = [];
                const stripped = src.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, function(_, lang, code) {
                    codeBlocks.push({ lang: (lang || '').trim(), code: String(code).replace(/\n$/, '') });
                    return '\n\u0001CODE' + (codeBlocks.length - 1) + '\u0001\n';
                });

                const lines = escapeHtml(stripped).split('\n');
                const html = [];
                let i = 0;

                while (i < lines.length) {
                    const line = lines[i];
                    const ph = line.match(/^\u0001CODE(\d+)\u0001$/);
                    const blank = line.trim() === '';

                    if (ph) {
                        html.push(buildCodeBlock(codeBlocks[Number(ph[1])]));
                        i++;
                        continue;
                    }
                    if (blank) { i++; continue; }

                    const heading = line.match(/^(#{1,6})\s+(.*)$/);
                    if (heading) {
                        const level = Math.min(heading[1].length + 1, 4);
                        html.push('<h' + level + '>' + inlineMarkdown(heading[2].trim()) + '</h' + level + '>');
                        i++;
                        continue;
                    }

                    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
                        html.push('<hr>');
                        i++;
                        continue;
                    }

                    if (/^\s*&gt;\s?/.test(line)) {
                        const buf = [];
                        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
                            buf.push(lines[i].replace(/^\s*&gt;\s?/, ''));
                            i++;
                        }
                        html.push('<blockquote>' + inlineMarkdown(buf.join('\n')).replace(/\n/g, '<br>') + '</blockquote>');
                        continue;
                    }

                    if (isTableStart(lines, i)) {
                        const header = splitTableRow(line);
                        let r = i + 2;
                        const rows = [];
                        while (r < lines.length && lines[r].indexOf('|') !== -1 && lines[r].trim() !== '') {
                            rows.push(splitTableRow(lines[r]));
                            r++;
                        }
                        let table = '<table><thead><tr>';
                        header.forEach(function(c) { table += '<th>' + inlineMarkdown(c.trim()) + '</th>'; });
                        table += '</tr></thead><tbody>';
                        rows.forEach(function(row) {
                            table += '<tr>';
                            for (let c = 0; c < header.length; c++) {
                                table += '<td>' + inlineMarkdown((row[c] || '').trim()) + '</td>';
                            }
                            table += '</tr>';
                        });
                        table += '</tbody></table>';
                        html.push(table);
                        i = r;
                        continue;
                    }

                    if (/^\s*[-*+]\s+/.test(line)) {
                        const items = [];
                        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
                            items.push('<li>' + inlineMarkdown(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>');
                            i++;
                        }
                        html.push('<ul>' + items.join('') + '</ul>');
                        continue;
                    }

                    if (/^\s*\d+[.)]\s+/.test(line)) {
                        const items = [];
                        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
                            items.push('<li>' + inlineMarkdown(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>');
                            i++;
                        }
                        html.push('<ol>' + items.join('') + '</ol>');
                        continue;
                    }

                    const buf = [line];
                    i++;
                    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i]) && !isTableStart(lines, i)) {
                        buf.push(lines[i]);
                        i++;
                    }
                    html.push('<p>' + inlineMarkdown(buf.join('\n')).replace(/\n/g, '<br>') + '</p>');
                }

                return sanitizeHtml(html.join(''));
            }

            // Code-block copy buttons are delegated: replies are re-rendered on
            // every streamed chunk, so binding per block would leak listeners.
            if (messagesWrapper) {
                messagesWrapper.addEventListener('click', function(e) {
                    const btn = e.target.closest('[data-code-copy]');
                    if (!btn) return;
                    const codeEl = btn.closest('.code-block').querySelector('code');
                    const code = codeEl ? codeEl.textContent : '';
                    navigator.clipboard.writeText(code).then(function() {
                        const label = btn.querySelector('span');
                        if (label) label.textContent = 'Copied!';
                        setTimeout(function() {
                            if (label) label.textContent = 'Copy';
                        }, 2000);
                    });
                });
            }

            // ===== TYPEWRITER =====
            // Reveals streamed text at a steady pace instead of dumping whole
            // chunks, so a long reply paints smoothly. `paint` receives the
            // visible slice on every frame.
            function createTypewriter(paint) {
                let full = '';
                let shown = 0;
                let timer = null;
                let isDone = false;

                function tick() {
                    if (shown >= full.length) {
                        if (isDone) stop();
                        return;
                    }
                    const backlog = full.length - shown;
                    const step = Math.max(1, Math.ceil(backlog / 6));
                    shown = Math.min(full.length, shown + step);
                    paint(full.slice(0, shown));
                }

                function start() {
                    if (timer === null && shown < full.length) {
                        timer = setInterval(tick, 20);
                    }
                }

                function stop() {
                    if (timer !== null) {
                        clearInterval(timer);
                        timer = null;
                    }
                }

                return {
                    push: function(chunk) {
                        if (chunk) full += chunk;
                        start();
                    },
                    finish: function() {
                        isDone = true;
                        shown = full.length;
                        stop();
                        paint(full);
                    },
                    stop: stop
                };
            }

            // ===== SCROLL (pinned-to-bottom + jump button) =====
            function nearBottom() {
                return chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 80;
            }

            function updateScrollFab() {
                if (!btnScrollBottom) return;
                btnScrollBottom.hidden = isPinnedToBottom || messagesWrapper.children.length === 0;
            }

            // `force` is used when the view must follow (new turn, load, send);
            // without it the view only follows while the user is at the bottom.
            function scrollToBottom(force) {
                if (!force && !isPinnedToBottom) {
                    updateScrollFab();
                    return;
                }
                requestAnimationFrame(function() {
                    chatArea.scrollTop = chatArea.scrollHeight;
                    updateScrollFab();
                });
            }

            if (chatArea) {
                chatArea.addEventListener('scroll', function() {
                    isPinnedToBottom = nearBottom();
                    updateScrollFab();
                });
            }

            if (btnScrollBottom) {
                btnScrollBottom.addEventListener('click', function() {
                    isPinnedToBottom = true;
                    scrollToBottom(true);
                });
            }

            // Send button: doubles as Stop while a reply is streaming.
            btnSend.addEventListener('click', function() {
                if (sending) {
                    stopGeneration();
                    return;
                }
                sendMessage(chatInput.value);
            });

            // Enter to send (Shift+Enter for newline)
            chatInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (this.value.trim()) {
                        sendMessage(this.value);
                    }
                }
            });

            // ===== QUICK ACTIONS =====
            quickActions.forEach(function(btn) {
                btn.addEventListener('click', function() {
                    chatInput.value = this.textContent;
                    updateSendState();
                    sendMessage(this.textContent);
                });
            });
            updateSendState();

            // ===== HISTORY: select / rename / delete (delegated, server-backed) =====
            if (chatHistoryNav) {
                chatHistoryNav.addEventListener('click', function(e) {
                    if (e.target.closest('.history-rename-input')) return;
                    const item = e.target.closest('.history-item');
                    if (!item) return;
                    const id = item.getAttribute('data-id');
                    const actionBtn = e.target.closest('.btn-item-action');
                    if (actionBtn) {
                        e.stopPropagation();
                        if (actionBtn.getAttribute('aria-label') === 'Delete') {
                            deleteConversation(id);
                        } else {
                            startRename(item, id);
                        }
                        return;
                    }
                    loadConversation(id);
                    if (getBreakpoint() !== 'desktop') {
                        closeSidebar();
                    }
                });
            }

            // ===== NEW CHAT (real: resets view, next message starts a new thread) =====
            btnNewChat.addEventListener('click', function() {
                startNewChat();
            });

            // Initial paint: the sidebar itself is filled by refreshAuth(), which
            // re-reads it once the server has said who is asking.
            setModelPicker('default');
            renderHistory();

            // ===== PWA: SERVICE WORKER =====
            if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                    navigator.serviceWorker.register('sw.js').catch(function() {
                        // Registration is best-effort: the app works without it.
                    });
                });
            }

            // ===== SEARCH POPUP (icon -> popup bar + conversation list) =====
            const btnSearchPopup = document.getElementById('btnSearchPopup');
            const searchPopup = document.getElementById('searchPopup');
            const searchPopupInput = document.getElementById('searchPopupInput');
            const searchPopupList = document.getElementById('searchPopupList');
            const searchPopupEmpty = document.getElementById('searchPopupEmpty');
            const btnPopupClear = document.getElementById('btnPopupClear');

            function closeSearchPopup() {
                if (searchPopup) searchPopup.hidden = true;
            }

            function renderSearchResults(query) {
                query = (query || '').trim().toLowerCase();
                if (!searchPopupList) return;
                searchPopupList.innerHTML = '';
                const items = Array.from(document.querySelectorAll('.history-item'));
                const matches = items.filter(function(item) {
                    const t = item.querySelector('.history-item-text');
                    return t && (!query || t.textContent.toLowerCase().indexOf(query) !== -1);
                });
                if (btnPopupClear) btnPopupClear.hidden = !query;
                if (searchPopupEmpty) searchPopupEmpty.hidden = matches.length !== 0;
                matches.forEach(function(item) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'search-popup-item' + (item.classList.contains('active') ? ' active' : '');
                    const label = document.createElement('span');
                    label.className = 'search-popup-item-text';
                    label.textContent = item.querySelector('.history-item-text').textContent;
                    btn.appendChild(label);
                    btn.addEventListener('click', function() {
                        item.click();
                        closeSearchPopup();
                    });
                    searchPopupList.appendChild(btn);
                });
            }

            function openSearchPopup() {
                if (!searchPopup) return;
                searchPopup.hidden = false;
                renderSearchResults(searchPopupInput ? searchPopupInput.value : '');
                if (searchPopupInput) searchPopupInput.focus();
            }

            if (btnSearchPopup) {
                btnSearchPopup.addEventListener('click', function(e) {
                    e.stopPropagation();
                    if (searchPopup && !searchPopup.hidden) {
                        closeSearchPopup();
                    } else {
                        openSearchPopup();
                    }
                });
            }

            if (searchPopup) {
                searchPopup.addEventListener('click', function(e) {
                    e.stopPropagation();
                });
            }

            if (searchPopupInput) {
                searchPopupInput.addEventListener('input', function() {
                    renderSearchResults(this.value);
                });
                searchPopupInput.addEventListener('keydown', function(e) {
                    if (e.key === 'Escape') {
                        this.value = '';
                        renderSearchResults('');
                        closeSearchPopup();
                    }
                });
            }

            if (btnPopupClear) {
                btnPopupClear.addEventListener('click', function() {
                    if (searchPopupInput) {
                        searchPopupInput.value = '';
                        renderSearchResults('');
                        searchPopupInput.focus();
                    }
                });
            }

            // ===== THEME TOGGLE + APPEARANCE SETTING =====
            const appearanceSelect = document.getElementById('appearanceSelect');

            function syncAppearanceSelect(theme) {
                if (appearanceSelect) {
                    appearanceSelect.value = theme === 'light' ? 'Light' : 'Dark';
                }
            }

            function applyTheme(theme) {
                document.body.classList.toggle('light', theme === 'light');
                syncAppearanceSelect(theme);
                try {
                    sessionStorage.setItem('chatbot-theme', theme);
                } catch (e) {}
            }

            if (appearanceSelect) {
                appearanceSelect.addEventListener('change', function() {
                    applyTheme(this.value === 'Light' ? 'light' : 'dark');
                });
            }

            // Load saved theme (sessionStorage: survives refresh, resets on browser close)
            (function initTheme() {
                let savedTheme = null;
                try {
                    savedTheme = sessionStorage.getItem('chatbot-theme');
                } catch (e) {}
                if (savedTheme) {
                    applyTheme(savedTheme);
                } else {
                    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
                    applyTheme(prefersLight ? 'light' : 'dark');
                }
            })();

            // Topbar shortcut mirrors the Appearance setting.
            if (btnThemeToggle) {
                btnThemeToggle.addEventListener('click', function() {
                    const isLight = document.body.classList.contains('light');
                    applyTheme(isLight ? 'dark' : 'light');
                });
            }

            // ===== MODEL DROPDOWN =====
            function closeModelDropdown() {
                modelDropdown.hidden = true;
                btnModelDropdown.parentElement.classList.remove('open');
            }

            if (btnModelDropdown) {
                btnModelDropdown.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const isOpen = !modelDropdown.hidden;
                    closeModelDropdown();
                    closePlusDropdown();
                    closeSearchPopup();
                    if (!isOpen) {
                        modelDropdown.hidden = false;
                        btnModelDropdown.parentElement.classList.add('open');
                    }
                });
            }

            if (modelDropdown) {
                modelOptions.forEach(function(opt) {
                    opt.addEventListener('click', function() {
                        const key = modelKeyFromLabel(this.getAttribute('data-model'));
                        // Fast path: a keyless cloud model cannot be picked. The
                        // server re-checks on send and is the real gate.
                        if (!modelHasKey(key)) {
                            closeModelDropdown();
                            showKeyAlert(key);
                            return;
                        }
                        // The choice is only sent with the next turn, so nothing
                        // changes server-side here.
                        setModelPicker(key);
                        closeModelDropdown();
                    });
                });
            }

            // ===== PLUS TOOL DROPDOWN (opens upward) =====
            const btnPlus = document.getElementById('btnPlus');
            const plusDropdown = document.getElementById('plusDropdown');

            function plusDropdownIsOpen() {
                return plusDropdown && !plusDropdown.hidden;
            }

            function closeAllSubmenus() {
                if (!plusDropdown) return;
                plusDropdown.querySelectorAll('.plus-submenu.open').forEach(function(m) {
                    m.classList.remove('open');
                });
                plusDropdown.querySelectorAll('.plus-option-wrapper.open').forEach(function(w) {
                    w.classList.remove('open');
                });
            }

            function closePlusDropdown() {
                if (plusDropdown) {
                    plusDropdown.hidden = true;
                    if (btnPlus) btnPlus.classList.remove('open');
                    closeAllSubmenus();
                }
            }

            function handlePlusChoice(item) {
                const label = (item.textContent || '').trim();
                if (!label) return;
                chatInput.value = (chatInput.value ? chatInput.value.replace(/\s+$/, '') + ' ' : '') + '[' + label + '] ';
                updateSendState();
                chatInput.focus();
            }

            if (btnPlus && plusDropdown) {
                btnPlus.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const isOpen = !plusDropdown.hidden;
                    closeModelDropdown();
                    closeSearchPopup();
                    closePlusDropdown();
                    if (!isOpen) {
                        plusDropdown.hidden = false;
                        btnPlus.classList.add('open');
                    }
                });

                plusDropdown.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const submenuTrigger = e.target.closest('[data-submenu]');
                    if (submenuTrigger && plusDropdown.contains(submenuTrigger)) {
                        const menu = document.getElementById(submenuTrigger.getAttribute('data-submenu'));
                        const wrapper = submenuTrigger.closest('.plus-option-wrapper');
                        const willOpen = menu && !menu.classList.contains('open');
                        closeAllSubmenus();
                        if (menu && wrapper && willOpen) {
                            menu.classList.add('open');
                            wrapper.classList.add('open');
                        }
                        return;
                    }
                    if (e.target.closest('.dropdown-item')) {
                        handlePlusChoice(e.target.closest('.dropdown-item'));
                        closePlusDropdown();
                        return;
                    }
                    // Leaf actions (upload / voice / create image) have their own
                    // handlers below; just close the menu here.
                    closePlusDropdown();
                });
            }

            // ===== PLUS ACTIONS: upload / voice / create image =====
            const uploadBtn = document.getElementById('btnUploadFile');
            const fileInput = document.getElementById('fileInput');

            if (uploadBtn && fileInput) {
                uploadBtn.addEventListener('click', function() {
                    fileInput.click();
                });
            }

            if (fileInput) {
                fileInput.addEventListener('change', function(e) {
                    const files = Array.from(e.target.files || []);
                    // Only the names travel: the backend takes no file bytes, so
                    // the file is never read here at all.
                    files.forEach(function(file) {
                        attachedFiles.push({
                            name: file.name,
                            type: file.type || ''
                        });
                        renderFilePreview(file);
                    });
                    fileInput.value = '';
                });
            }

            function renderFilePreview(file) {
                const filePreviewArea = document.getElementById('filePreviewArea');
                if (!filePreviewArea) return;
                filePreviewArea.hidden = false;
                const chip = document.createElement('div');
                chip.className = 'file-chip';
                const name = document.createElement('span');
                name.textContent = file.name;
                name.title = file.name;
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'file-chip-remove';
                remove.setAttribute('aria-label', 'Remove attachment');
                remove.textContent = '×';
                remove.addEventListener('click', function() {
                    const idx = attachedFiles.findIndex(function(f) { return f.name === file.name; });
                    if (idx !== -1) attachedFiles.splice(idx, 1);
                    chip.remove();
                    if (!filePreviewArea.hasChildNodes()) filePreviewArea.hidden = true;
                    updateSendState();
                });
                chip.appendChild(name);
                chip.appendChild(remove);
                filePreviewArea.appendChild(chip);
                updateSendState();
            }

            // ===== RAG: CLIENT-SIDE DOCUMENT EXTRACTION (PDF / TXT) =====
            // A lightweight, in-browser "retrieval" step: the chosen file's text is
            // extracted locally and folded into the next prompt as hidden context.
            // Nothing is uploaded, and only the capped *text* is retained — the
            // source File/ArrayBuffer is released as soon as extraction ends, so a
            // large PDF cannot pin memory.
            const RAG_MAX_CHARS = 120000;                 // ~30k tokens of context, hard cap
            const RAG_MAX_PAGES = 50;                     // stop early on very long PDFs
            const RAG_MAX_BYTES = 25 * 1024 * 1024;       // refuse files above 25 MB

            if (window.pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
                pdfjsLib.GlobalWorkerOptions.workerSrc =
                    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
            }

            const btnAttachDoc = document.getElementById('btnAttachDoc');
            const docInput = document.getElementById('docInput');
            const docIndicator = document.getElementById('docIndicator');
            const docIndicatorName = document.getElementById('docIndicatorName');
            const docIndicatorStatus = document.getElementById('docIndicatorStatus');
            const docIndicatorRemove = document.getElementById('docIndicatorRemove');
            let docReading = false;

            function renderDocIndicator(name, status, state) {
                if (!docIndicator) return;
                docIndicator.hidden = false;
                docIndicator.classList.toggle('is-loading', state === 'loading');
                docIndicator.classList.toggle('is-error', state === 'error');
                if (docIndicatorName) docIndicatorName.textContent = name || '';
                if (docIndicatorStatus) docIndicatorStatus.textContent = status || '';
                if (docIndicatorRemove) docIndicatorRemove.hidden = (state === 'loading');
                if (btnAttachDoc) btnAttachDoc.classList.toggle('has-doc', state !== 'error');
            }

            function clearRagDoc() {
                ragDoc = null;
                if (docIndicator) {
                    docIndicator.hidden = true;
                    docIndicator.classList.remove('is-loading', 'is-error');
                }
                if (btnAttachDoc) btnAttachDoc.classList.remove('has-doc');
                updateSendState();
            }

            function flashDocError(message) {
                renderDocIndicator(message, '', 'error');
                window.setTimeout(function() {
                    // Only auto-clear if this error chip is still the current one.
                    if (docIndicator && docIndicator.classList.contains('is-error')) {
                        clearRagDoc();
                    }
                }, 4000);
            }

            // pdf.js text items -> a plain string. Items may carry their own EOL.
            function pdfItemsToText(items) {
                let out = '';
                for (let i = 0; i < items.length; i++) {
                    const it = items[i];
                    if (it && typeof it.str === 'string') out += it.str;
                    if (it && it.hasEOL) out += '\n';
                    if (out.length >= RAG_MAX_CHARS) break;
                }
                return out;
            }

            // Extracts text from a PDF with pdf.js. The document (and its worker)
            // are always torn down in `finally`, and the source buffer is dropped.
            async function extractPdfText(file) {
                const lib = window.pdfjsLib;
                if (!lib || typeof lib.getDocument !== 'function') {
                    throw new Error('pdf.js unavailable');
                }
                const buffer = await file.arrayBuffer();
                let pdf = null;
                try {
                    pdf = await lib.getDocument({ data: new Uint8Array(buffer) }).promise;
                    const pageCount = Math.min(pdf.numPages, RAG_MAX_PAGES);
                    let text = '';
                    for (let p = 1; p <= pageCount; p++) {
                        const page = await pdf.getPage(p);
                        try {
                            const content = await page.getTextContent();
                            text += pdfItemsToText(content.items) + '\n';
                        } finally {
                            page.cleanup();
                        }
                        if (text.length >= RAG_MAX_CHARS) break;
                    }
                    return text.slice(0, RAG_MAX_CHARS).trim();
                } finally {
                    if (pdf) {
                        try { await pdf.destroy(); } catch (e) {}
                    }
                }
            }

            async function extractDocText(file) {
                const name = (file.name || '').toLowerCase();
                const isPdf = name.endsWith('.pdf') || file.type === 'application/pdf';
                if (isPdf) return await extractPdfText(file);
                // Everything else is treated as plain text (.txt / text/plain).
                return (await file.text()).slice(0, RAG_MAX_CHARS).trim();
            }

            async function handleDocFile(file) {
                if (!file || docReading) return;
                if (file.size > RAG_MAX_BYTES) {
                    flashDocError(file.name + ' — too large');
                    if (docInput) docInput.value = '';
                    return;
                }
                docReading = true;
                renderDocIndicator(file.name, 'reading…', 'loading');
                if (docInput) docInput.disabled = true;
                try {
                    const text = await extractDocText(file);
                    if (!text) {
                        flashDocError(file.name + ' — no text found');
                        return;
                    }
                    ragDoc = { name: file.name, text: text };
                    renderDocIndicator(file.name, 'attached', 'ready');
                    updateSendState();
                } catch (e) {
                    flashDocError(file.name + ' — could not read');
                } finally {
                    docReading = false;
                    if (docInput) {
                        docInput.disabled = false;
                        docInput.value = ''; // allow re-selecting the same file
                    }
                }
            }

            if (btnAttachDoc && docInput) {
                btnAttachDoc.addEventListener('click', function() {
                    docInput.click();
                });
            }

            if (docInput) {
                docInput.addEventListener('change', function(e) {
                    const file = e.target.files && e.target.files[0];
                    if (file) handleDocFile(file);
                    else docInput.value = '';
                });
            }

            if (docIndicatorRemove) {
                docIndicatorRemove.addEventListener('click', function() {
                    clearRagDoc();
                });
            }

            const btnVoiceInput = document.getElementById('btnVoiceInput');
            if (btnVoiceInput) {
                btnVoiceInput.addEventListener('click', function() {
                    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
                    if (!SR) {
                        chatInput.focus();
                        return;
                    }
                    try {
                        const rec = new SR();
                        rec.lang = (navigator.language || 'en-US');
                        rec.interimResults = false;
                        rec.maxAlternatives = 1;
                        rec.onresult = function(ev) {
                            const transcript = Array.from(ev.results).map(function(r) { return r[0].transcript; }).join(' ');
                            chatInput.value = (chatInput.value ? chatInput.value.replace(/\s+$/, '') + ' ' : '') + transcript;
                            updateSendState();
                            chatInput.focus();
                        };
                        rec.start();
                    } catch (err) {}
                });
            }

            const btnCreateImage = document.getElementById('btnCreateImage');
            if (btnCreateImage) {
                btnCreateImage.addEventListener('click', function() {
                    const prefix = '/image ';
                    if (chatInput.value.indexOf(prefix) !== 0) {
                        chatInput.value = prefix + chatInput.value;
                    }
                    updateSendState();
                    chatInput.focus();
                });
            }

            document.addEventListener('click', function() {
                if (modelDropdown && !modelDropdown.hidden) closeModelDropdown();
                if (plusDropdownIsOpen()) closePlusDropdown();
                closeSearchPopup();
                closeUserMenu();
            });

            // ===== KEYBOARD SHORTCUT =====
            document.addEventListener('keydown', function(e) {
                if (e.ctrlKey && e.key === 'b') {
                    e.preventDefault();
                    toggleSidebar();
                }
            });

        })();

        // ===== SETTINGS MODAL =====
        (function() {
            const settingsModalOverlay = document.getElementById('settingsModalOverlay');
            const btnOpenSettings = document.getElementById('btnOpenSettings');
            const btnCloseSettings = document.getElementById('btnCloseSettings');
            const settingsPageTitle = document.getElementById('settingsPageTitle');
            const settingsMenuItems = document.querySelectorAll('.settings-menu-item');
            const mfaBanner = document.getElementById('mfaBanner');
            const btnCloseBanner = document.getElementById('btnCloseBanner');
            const btnSetupMfa = document.getElementById('btnSetupMfa');
            const settingsMenuSearch = document.getElementById('settingsMenuSearch');
            const accentColorSelect = document.getElementById('accentColorSelect');
            const accentDot = document.getElementById('accentDot');
            const contrastSelect = document.getElementById('contrastSelect');
            const languageSelect = document.getElementById('languageSelect');

            // Open Settings Modal
            if (btnOpenSettings) {
                btnOpenSettings.addEventListener('click', () => {
                    settingsModalOverlay.classList.add('active');
                });
            }

            // Close Settings Modal
            if (btnCloseSettings) {
                btnCloseSettings.addEventListener('click', () => {
                    settingsModalOverlay.classList.remove('active');
                });
            }

            // Close on overlay click
            if (settingsModalOverlay) {
                settingsModalOverlay.addEventListener('click', (e) => {
                    if (e.target === settingsModalOverlay) {
                        settingsModalOverlay.classList.remove('active');
                    }
                });
            }

            // Close on Escape key
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && settingsModalOverlay.classList.contains('active')) {
                    settingsModalOverlay.classList.remove('active');
                }
            });

            // Sidebar Menu Navigation & Panel Switch
            const settingsPanels = document.querySelectorAll('.settings-panel');

            function showSettingsPanel(key) {
                settingsPanels.forEach(panel => {
                    panel.classList.toggle('active', panel.getAttribute('data-panel') === key);
                });
            }

            settingsMenuItems.forEach(item => {
                item.addEventListener('click', () => {
                    settingsMenuItems.forEach(el => el.classList.remove('active'));
                    item.classList.add('active');
                    if (settingsPageTitle) {
                        settingsPageTitle.textContent = item.getAttribute('data-title');
                    }
                    showSettingsPanel(item.getAttribute('data-panel'));
                });
            });

            // Public bridge: open the modal directly on a panel
            // (used by the API-key gate in the chat engine).
            window.ChatBotSettings = window.ChatBotSettings || {};
            window.ChatBotSettings.openPanel = function(key) {
                if (settingsModalOverlay) settingsModalOverlay.classList.add('active');
                var activeItem = null;
                settingsMenuItems.forEach(function(el) {
                    var match = el.getAttribute('data-panel') === key;
                    el.classList.toggle('active', match);
                    if (match) activeItem = el;
                });
                showSettingsPanel(key);
                if (settingsPageTitle) {
                    settingsPageTitle.textContent = activeItem
                        ? activeItem.getAttribute('data-title')
                        : (key.charAt(0).toUpperCase() + key.slice(1));
                }
                if (key === 'account') refreshAccountPanel();
            };

            // Sidebar footer gear button — quick access to the Safety panel.
            const btnSidebarSettings = document.getElementById('btnSidebarSettings');
            if (btnSidebarSettings) {
                btnSidebarSettings.addEventListener('click', function() {
                    window.ChatBotSettings.openPanel('safety');
                });
            }

            // ===== ACCOUNT PANEL (email + sign out everywhere + delete) =====
            const accountEmail = document.getElementById('accountEmail');
            const btnSignOutAll = document.getElementById('btnSignOutAll');
            const btnDeleteAccount = document.getElementById('btnDeleteAccount');

            function refreshAccountPanel() {
                const user = window.ChatBotAuth ? window.ChatBotAuth.getUser() : null;
                if (accountEmail) {
                    accountEmail.textContent = user ? (user.email || user.name || 'Signed in') : 'Not signed in';
                }
                if (btnSignOutAll) btnSignOutAll.disabled = !user;
                if (btnDeleteAccount) btnDeleteAccount.disabled = !user;
            }

            if (window.ChatBotAuth) window.ChatBotAuth.refreshAccountPanel = refreshAccountPanel;
            refreshAccountPanel();

            if (btnSignOutAll) {
                btnSignOutAll.addEventListener('click', function() {
                    if (window.ChatBotAuth) window.ChatBotAuth.signOut(true);
                });
            }

            if (btnDeleteAccount) {
                btnDeleteAccount.addEventListener('click', function() {
                    if (confirm('Delete your account permanently? Its saved conversations are deleted with it.')) {
                        if (window.ChatBotAuth) window.ChatBotAuth.deleteAccount();
                    }
                });
            }

            // Sidebar Menu Search Filter
            if (settingsMenuSearch) {
                settingsMenuSearch.addEventListener('input', (e) => {
                    const query = e.target.value.toLowerCase();
                    settingsMenuItems.forEach(item => {
                        const text = item.textContent.toLowerCase();
                        if (text.includes(query)) {
                            item.style.display = 'flex';
                        } else {
                            item.style.display = 'none';
                        }
                    });
                });
            }

            // MFA Banner Close
            if (btnCloseBanner) {
                btnCloseBanner.addEventListener('click', () => {
                    mfaBanner.classList.add('dismissed');
                });
            }

            if (btnSetupMfa) {
                btnSetupMfa.addEventListener('click', () => {
                    alert('Setup MFA initiated. This feature will be implemented soon.');
                });
            }

            // Accent Color: dot + body theme class (persisted)
            const colorMap = {
                'Default': '#8e8e8e',
                'Blue': '#3b82f6',
                'Green': '#10a37f',
                'Purple': '#a855f7',
                'Orange': '#f97316'
            };
            const accentClassMap = {
                'Default': '',
                'Blue': 'accent-blue',
                'Green': 'accent-green',
                'Purple': 'accent-purple',
                'Orange': 'accent-orange'
            };

            function applyAccent(value) {
                document.body.classList.remove('accent-blue', 'accent-green', 'accent-purple', 'accent-orange');
                const cls = accentClassMap[value];
                if (cls) document.body.classList.add(cls);
                if (accentDot) {
                    accentDot.style.backgroundColor = colorMap[value] || '#8e8e8e';
                }
                try {
                    sessionStorage.setItem('chatbot-accent', value);
                } catch (e) {}
            }

            if (accentColorSelect) {
                accentColorSelect.addEventListener('change', (e) => {
                    applyAccent(e.target.value);
                });
                let savedAccent = null;
                try {
                    savedAccent = sessionStorage.getItem('chatbot-accent');
                } catch (e) {}
                if (savedAccent && colorMap[savedAccent]) {
                    accentColorSelect.value = savedAccent;
                    applyAccent(savedAccent);
                }
            }

            // Contrast setting: toggles high-contrast body class (persisted)
            function applyContrast(value) {
                document.body.classList.toggle('contrast-high', value === 'High');
                try {
                    sessionStorage.setItem('chatbot-contrast', value);
                } catch (e) {}
            }

            if (contrastSelect) {
                contrastSelect.addEventListener('change', (e) => {
                    applyContrast(e.target.value);
                });
                try {
                    const savedContrast = sessionStorage.getItem('chatbot-contrast');
                    if (savedContrast) {
                        contrastSelect.value = savedContrast;
                        applyContrast(savedContrast);
                    }
                } catch (e) {}
            }

            // Language setting: persisted, applied on next load (no i18n engine yet)
            if (languageSelect) {
                try {
                    const savedLang = sessionStorage.getItem('chatbot-lang');
                    if (savedLang) languageSelect.value = savedLang;
                } catch (e) {}
                languageSelect.addEventListener('change', (e) => {
                    try {
                        sessionStorage.setItem('chatbot-lang', e.target.value);
                    } catch (err) {}
                });
            }

            // ===== API KEY SETTINGS (6 providers, persisted in ChatBotStore) =====
            // These keys never leave the browser except as per-request headers on
            // POST /api/chat. The server holds them only for that request.
            function refreshApiStatus(card, has) {
                const st = card.querySelector('[data-api-status]');
                if (!st) return;
                if (card.getAttribute('data-provider') === 'default') {
                    st.textContent = 'Ready';
                    st.classList.add('saved');
                    return;
                }
                st.textContent = has ? 'Saved' : 'Not set';
                st.classList.toggle('saved', !!has);
            }

            function initApiKeys() {
                const panel = document.querySelector('.settings-panel[data-panel="api-key"]');
                if (!panel || !window.ChatBotStore) return;
                const keys = window.ChatBotStore.loadKeys();
                panel.querySelectorAll('.api-card').forEach(function(card) {
                    const provider = card.getAttribute('data-provider');
                    const keyInput = card.querySelector('[data-api-field="key"]');
                    const baseInput = card.querySelector('[data-api-field="baseUrl"]');
                    const modelInput = card.querySelector('[data-api-field="model"]');

                    // Personal-provider cards store a key plus, optionally, a
                    // base URL and model override of their own.
                    if (keyInput) keyInput.value = keys[provider] || '';
                    if (baseInput) baseInput.value = keys[provider + 'BaseUrl'] || '';
                    if (modelInput) modelInput.value = keys[provider + 'Model'] || '';
                    refreshApiStatus(card, provider === 'default' ? true : !!(keys[provider] && keys[provider].trim()));

                    const toggle = card.querySelector('[data-api-toggle]');
                    if (toggle && keyInput) {
                        toggle.addEventListener('click', function() {
                            keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
                        });
                    }

                    const saveBtn = card.querySelector('[data-api-save]');
                    function doSave() {
                        const all = window.ChatBotStore.loadKeys();
                        if (keyInput) all[provider] = keyInput.value.trim();
                        if (baseInput) all[provider + 'BaseUrl'] = baseInput.value.trim();
                        if (modelInput) all[provider + 'Model'] = modelInput.value.trim();
                        const ok = window.ChatBotStore.saveKeys(all);
                        refreshApiStatus(card, provider === 'default' ? true : !!(keyInput && keyInput.value.trim()));
                        if (saveBtn) {
                            saveBtn.textContent = ok ? 'Saved ✓' : 'Save failed';
                            setTimeout(function() { saveBtn.textContent = 'Save'; }, 1500);
                        }
                    }
                    if (saveBtn) {
                        saveBtn.addEventListener('click', doSave);
                    }
                    [keyInput, baseInput, modelInput].forEach(function(inp) {
                        if (inp) {
                            inp.addEventListener('keydown', function(e) {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    doSave();
                                }
                            });
                        }
                    });

                    const clearBtn = card.querySelector('[data-api-clear]');
                    if (clearBtn) {
                        clearBtn.addEventListener('click', function() {
                            const all = window.ChatBotStore.loadKeys();
                            all[provider] = '';
                            all[provider + 'BaseUrl'] = '';
                            all[provider + 'Model'] = '';
                            if (keyInput) keyInput.value = '';
                            if (baseInput) baseInput.value = '';
                            if (modelInput) modelInput.value = '';
                            window.ChatBotStore.saveKeys(all);
                            refreshApiStatus(card, provider === 'default');
                        });
                    }
                });
            }

            initApiKeys();
        })();


        const select = document.getElementById("languageSelect");
const SOURCE_LANG = "en"; // bahasa asli konten yang kamu tulis di HTML
const CACHE_KEY = "translationCache";
const PREF_KEY = "preferredLanguage";

// Nilai <option> di dropdown adalah nama tampilan ("Auto-detect", "Bahasa Indonesia", ...),
// sedangkan API translate butuh kode ("auto", "id", ...). Petakan di sini agar tidak
// pernah terkirim nilai mentah seperti "Auto-detect" ke API (itu yang meracuni seluruh UI).
const LANG_CODE_MAP = {
  "auto": "auto", "Auto-detect": "auto",
  "en": "en", "English (US)": "en",
  "id": "id", "Bahasa Indonesia": "id",
  "es": "es", "Español": "es",
  "fr": "fr", "Français": "fr",
  "de": "de", "Deutsch": "de",
  "ja": "ja", "日本語": "ja"
};

// Ciri respons error MyMemory (dulu sempat ditulis ke seluruh UI + cache).
const TRANSLATION_ERROR_RE = /invalid target language|invalid email|query length limit|no translation/i;

function resolveTargetLang(value) {
  const code = LANG_CODE_MAP[(value || "").trim()] || "auto";
  return code === "auto" ? detectBrowserLang() : code;
}

function isBadTranslation(data, text) {
  if (!data || data.responseStatus !== 200) return true;
  const t = (data.responseData && data.responseData.translatedText) || "";
  if (!t || t.trim() === "") return true;
  return TRANSLATION_ERROR_RE.test(t);
}

// Hapus entri cache yang berisi pesan error (pemulihan otomatis untuk browser
// yang sudah terlanjur keracunan sebelum fix ini dipasang).
function purgeBadCache() {
  try {
    const cache = getCache();
    let dirty = false;
    Object.keys(cache).forEach(k => {
      if (typeof cache[k] !== "string" || TRANSLATION_ERROR_RE.test(cache[k])) {
        delete cache[k];
        dirty = true;
      }
    });
    if (dirty) saveCache(cache);
  } catch (err) {}
}

// simpan teks asli tiap elemen, sekali aja, sebelum ada perubahan apapun
function captureOriginalText() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    if (!el.dataset.original) {
      el.dataset.original = el.textContent.trim();
    }
  });
}

function getCache() {
  return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
}
function saveCache(cache) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

function detectBrowserLang() {
  const supported = ["en", "id", "es", "fr", "de", "ja"];
  const nav = (navigator.language || "en").slice(0, 2);
  return supported.includes(nav) ? nav : "en";
}

async function translateText(text, targetLang) {
  if (targetLang === SOURCE_LANG) return text;

  const cache = getCache();
  const cacheKey = `${targetLang}:${text}`;
  if (cache[cacheKey]) {
    // Jangan pernah pakai cache yang ternyata pesan error.
    if (TRANSLATION_ERROR_RE.test(cache[cacheKey])) {
      delete cache[cacheKey];
      try { saveCache(cache); } catch (err) {}
    } else {
      return cache[cacheKey];
    }
  }

  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${SOURCE_LANG}|${targetLang}`;
    const res = await fetch(url);
    const data = await res.json();
    // Respons error API (status != 200 / pesan INVALID ...) jangan dipakai & jangan di-cache.
    if (isBadTranslation(data, text)) return text;
    const translated = data.responseData.translatedText;

    cache[cacheKey] = translated;
    saveCache(cache);
    return translated;
  } catch (err) {
    console.error("Translation failed:", err);
    return text; // fallback ke teks asli kalau API gagal
  }
}

async function applyLanguage(lang) {
  const targetLang = resolveTargetLang(lang);
  const nodes = document.querySelectorAll("[data-i18n]");

  document.body.style.opacity = "0.6"; // indikator loading ringan

  await Promise.all(
    Array.from(nodes).map(async el => {
      if (!el.dataset.original) return;
      const translated = await translateText(el.dataset.original, targetLang);
      el.textContent = translated;
    })
  );

  document.documentElement.setAttribute("lang", targetLang);
  document.body.style.opacity = "1";
}

function initLanguage() {
  captureOriginalText();
  purgeBadCache();
  let saved = null;
  try {
    saved = localStorage.getItem(PREF_KEY) || "auto";
  } catch (err) {
    saved = "auto";
  }
  if (!LANG_CODE_MAP[(saved || "").trim()]) saved = "auto";
  if (select) {
    const hasOption = Array.from(select.options).some(o => o.value === saved);
    if (hasOption) select.value = saved;
  }
  applyLanguage(saved);
}

if (select) {
  select.addEventListener("change", (e) => {
    const value = e.target.value;
    try {
      localStorage.setItem(PREF_KEY, value);
    } catch (err) {}
    applyLanguage(value);
  });
}

initLanguage();

// ====== Custom dropdown enhancer ======
// Mengubah <select class="custom-select"> jadi dropdown custom bergaya gambar,
// tanpa mengubah value/behavior JS lama (i18n, dsb) — select asli tetap disinkronkan.

function enhanceSelect(select) {
  const wrapper = select.closest('.select-wrapper');
  if (!wrapper || wrapper.dataset.enhanced) return;
  wrapper.dataset.enhanced = "true";

  const options = Array.from(select.options);

  // Trigger button
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dd-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const valueSpan = document.createElement('span');
  valueSpan.className = 'select-value';

  const arrow = document.createElement('i');
  arrow.className = 'fa-solid fa-chevron-down select-arrow';

  trigger.appendChild(valueSpan);
  trigger.appendChild(arrow);

  // Menu
  const menu = document.createElement('ul');
  menu.className = 'dd-menu';
  menu.setAttribute('role', 'listbox');

  function renderMenu() {
    menu.innerHTML = '';
    options.forEach(opt => {
      const li = document.createElement('li');
      li.className = 'dd-option';
      li.setAttribute('role', 'option');
      li.dataset.value = opt.value;
      li.setAttribute('aria-selected', opt.value === select.value ? 'true' : 'false');

      const label = document.createElement('span');
      label.textContent = opt.textContent;

      const check = document.createElement('i');
      check.className = 'fa-solid fa-check check';

      li.appendChild(label);
      li.appendChild(check);
      menu.appendChild(li);
    });
  }

  function setValue(value, { silent = false } = {}) {
    select.value = value;
    const selectedOpt = options.find(o => o.value === value);
    valueSpan.textContent = selectedOpt ? selectedOpt.textContent : '';
    menu.querySelectorAll('.dd-option').forEach(li => {
      li.setAttribute('aria-selected', li.dataset.value === value ? 'true' : 'false');
    });
    if (!silent) {
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function openMenu() {
    wrapper.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    wrapper.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.select-wrapper.open').forEach(w => {
      if (w !== wrapper) w.classList.remove('open');
    });
    wrapper.classList.contains('open') ? closeMenu() : openMenu();
  });

  menu.addEventListener('click', (e) => {
    const li = e.target.closest('.dd-option');
    if (!li) return;
    setValue(li.dataset.value);
    closeMenu();
    trigger.focus();
  });

  // Keyboard support dasar
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu();
      menu.querySelector('.dd-option')?.focus();
    }
  });
  menu.setAttribute('tabindex', '-1');
  menu.addEventListener('keydown', (e) => {
    const items = Array.from(menu.querySelectorAll('.dd-option'));
    const idx = items.findIndex(i => i === document.activeElement);
    if (e.key === 'Escape') { closeMenu(); trigger.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); (items[idx + 1] || items[0]).focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (items[idx - 1] || items[items.length - 1]).focus(); }
    if (e.key === 'Enter') { document.activeElement.click(); }
  });
  menu.querySelectorAll('.dd-option').forEach(li => li.tabIndex = -1);

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) closeMenu();
  });

  renderMenu();
  setValue(select.value, { silent: true });

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
}

function enhanceAllSelects() {
  document.querySelectorAll('select.custom-select').forEach(enhanceSelect);
}

document.addEventListener('DOMContentLoaded', enhanceAllSelects);

function initSettingsMenu() {
  const items = document.querySelectorAll('#settingsMenuList .settings-menu-item');
  const panels = document.querySelectorAll('#settingsPanels .settings-panel');

  items.forEach(item => {
    item.addEventListener('click', () => {
      const target = item.dataset.panel;

      items.forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      panels.forEach(panel => {
        panel.classList.toggle('active', panel.dataset.panel === target);
      });
    });
  });
}

document.addEventListener('DOMContentLoaded', initSettingsMenu);

