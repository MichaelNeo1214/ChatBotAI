        // ===== LOCAL PERSISTENT STORE (conversations + provider keys) =====
        // Shared by the chat engine and the settings panel. localStorage survives
        // refresh and browser restart; entries disappear only when deleted.
        // Conversations are namespaced per owner: 'guest' when signed out,
        // 'user:<id|email>' when signed in, so each account keeps its own history.
        window.ChatBotStore = (function() {
            const CONV_BASE = 'chatbot.conversations.v1';
            const KEYS_KEY = 'chatbot.apikeys.v1';
            const PROF_BASE = 'chatbot.profile.v1';
            let owner = 'guest';

            function convKey() {
                return CONV_BASE + ':' + owner;
            }

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
                return { openai: '', gemini: '', claude: '', deepseek: '', defaultBaseUrl: '', defaultModel: '' };
            }

            return {
                setOwner: function(next) {
                    owner = (next && String(next)) || 'guest';
                },
                getOwner: function() {
                    return owner;
                },
                loadConversations: function() {
                    const list = read(convKey(), []);
                    return Array.isArray(list) ? list : [];
                },
                saveConversations: function(list) {
                    return write(convKey(), list);
                },
                clearConversations: function(which) {
                    try {
                        localStorage.removeItem(CONV_BASE + ':' + ((which && String(which)) || owner));
                    } catch (e) {}
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
                    return write(KEYS_KEY, keys || defaultKeys());
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
                },
                makeId: function() {
                    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
            const btnThemeToggle = document.getElementById('btnThemeToggle');
            const btnScrollBottom = document.getElementById('btnScrollBottom');


            
            // State
            let chatStarted = false;
            // In-flight provider request handle. "Stop generating" aborts it so the
            // network call is cancelled, not just the on-screen typewriter.
            let activeRequestCtl = null;
            // Active typewriter streamer (or null). See stopGeneration().
            let activeStream = null;
            let isStreaming = false;
            const attachedFiles = [];
            let conversations = window.ChatBotStore.loadConversations();
            let activeConversationId = null;
            let currentModelKey = 'default';

            // ===== MODELS =====
            const MODEL_DEFS = [
                { key: 'default',  label: 'ChatBot AI', provider: 'local',     model: '' },
                { key: 'openai',   label: 'GPT-4o',     provider: 'openai',    model: 'gpt-4o' },
                { key: 'gemini',   label: 'Gemini',     provider: 'gemini',    model: 'gemini-2.0-flash' },
                { key: 'claude',   label: 'Claude',     provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
                { key: 'deepseek', label: 'DeepSeek',   provider: 'deepseek',  model: 'deepseek-chat' }
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
                const keys = getApiKeys();
                return !!(keys[key] && keys[key].trim());
            }

            // ===== PROVIDERS (local Jan + cloud APIs, direct from browser) =====
            function fetchWithTimeout(url, options, ms) {
                const controller = new AbortController();
                const timer = setTimeout(function() { controller.abort(); }, ms || 120000);
                if (activeRequestCtl) {
                    // Chain the shared "stop" signal onto this request without
                    // changing any of the provider call signatures.
                    if (activeRequestCtl.signal.aborted) {
                        controller.abort();
                    } else {
                        activeRequestCtl.signal.addEventListener('abort', function() {
                            controller.abort();
                        }, { once: true });
                    }
                }
                options = options || {};
                options.signal = controller.signal;
                return fetch(url, options).then(
                    function(res) { clearTimeout(timer); return res; },
                    function(err) { clearTimeout(timer); throw err; }
                );
            }

            function requestFailed(url, e) {
                if (e && e.name === 'AbortError') {
                    return 'Request to ' + url + ' timed out. The model may still be loading — please try again.';
                }
                return 'Cannot reach ' + url + ' (' + ((e && e.message) ? e.message : 'network error') + ').';
            }

            function base64ToText(b64) {
                try {
                    const bin = atob(b64);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    return new TextDecoder().decode(bytes);
                } catch (e) {
                    return '';
                }
            }

            function isTextFile(file) {
                const type = file.type || '';
                const name = file.name || '';
                if (type.indexOf('text/') === 0) return true;
                if (/json|csv|xml|javascript|markdown/.test(type)) return true;
                return /\.(txt|md|csv|json|js|ts|py|html|css|log)$/i.test(name);
            }

            function truncateMiddle(s, max) {
                if (s.length <= max) return s;
                return s.slice(0, max) + '\n...[truncated, file too long]...';
            }

            // Plain stored messages + current attachments -> OpenAI-style messages.
            function buildOpenAiMessages(history, files) {
                const msgs = history.map(function(m) {
                    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
                });
                if (!files || !files.length) return msgs;
                let lastUser = -1;
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i].role === 'user') { lastUser = i; break; }
                }
                if (lastUser === -1) return msgs;
                const parts = [{ type: 'text', text: msgs[lastUser].content }];
                files.forEach(function(f) {
                    const type = f.type || '';
                    if (type.indexOf('image/') === 0) {
                        parts.push({ type: 'image_url', image_url: { url: 'data:' + type + ';base64,' + f.data } });
                    } else if (isTextFile(f)) {
                        parts.push({ type: 'text', text: '\n\n[File: ' + f.name + ']\n' + truncateMiddle(base64ToText(f.data), 12000) });
                    } else {
                        parts.push({ type: 'text', text: '\n[Attached file: ' + f.name + ' (' + (type || 'unknown type') + ')]' });
                    }
                });
                msgs[lastUser].content = parts;
                return msgs;
            }

            // Local text models: strip vision parts to plain-text notes.
            function stripImagesForLocal(msgs) {
                return msgs.map(function(m) {
                    if (typeof m.content === 'string') return m;
                    let text = '';
                    let images = 0;
                    m.content.forEach(function(p) {
                        if (p.type === 'text') text += (text ? '\n' : '') + p.text;
                        else if (p.type === 'image_url') images++;
                    });
                    if (images > 0) text += '\n[' + images + ' image(s) attached — vision is not supported by this local model]';
                    return { role: m.role, content: text };
                });
            }

            function openAiContentToGeminiParts(content) {
                if (typeof content === 'string') return [{ text: content }];
                return content.map(function(p) {
                    if (p.type === 'text') return { text: p.text };
                    if (p.type === 'image_url') {
                        const m = /^data:(.*?);base64,([\s\S]*)$/.exec(p.image_url.url || '');
                        return { inline_data: { mime_type: m ? m[1] : 'image/png', data: m ? m[2] : '' } };
                    }
                    return { text: '' };
                });
            }

            function toGeminiContents(openAiMsgs) {
                return openAiMsgs.map(function(m) {
                    return {
                        role: m.role === 'assistant' ? 'model' : 'user',
                        parts: openAiContentToGeminiParts(m.content)
                    };
                });
            }

            function openAiContentToAnthropic(content) {
                if (typeof content === 'string') return content;
                return content.map(function(p) {
                    if (p.type === 'text') return { type: 'text', text: p.text };
                    if (p.type === 'image_url') {
                        const m = /^data:(.*?);base64,([\s\S]*)$/.exec(p.image_url.url || '');
                        return { type: 'image', source: { type: 'base64', media_type: m ? m[1] : 'image/png', data: m ? m[2] : '' } };
                    }
                    return { type: 'text', text: '' };
                });
            }

            function toAnthropicMessages(openAiMsgs) {
                return openAiMsgs.map(function(m) {
                    return {
                        role: m.role === 'assistant' ? 'assistant' : 'user',
                        content: openAiContentToAnthropic(m.content)
                    };
                });
            }

            function extractOpenAiText(data) {
                try {
                    const text = data.choices[0].message.content;
                    if (typeof text === 'string' && text.trim()) return text;
                    if (Array.isArray(text)) {
                        return text.filter(function(p) { return p.type === 'text'; }).map(function(p) { return p.text; }).join('');
                    }
                } catch (e) {}
                return '';
            }

            async function throwForBadStatus(res, keyName) {
                let msg = 'HTTP ' + res.status;
                try {
                    const detail = await res.json();
                    if (detail && detail.error && detail.error.message) msg = detail.error.message;
                } catch (e) {}
                if (res.status === 401 || res.status === 403) {
                    msg += ' — check your API key in Settings → API Key.';
                }
                throw new Error(msg);
            }

            async function detectJanModel(base) {
                let res;
                try {
                    res = await fetchWithTimeout(base + '/models', {}, 15000);
                } catch (e) {
                    throw new Error("Couldn't reach Jan at " + base + '. Open Jan, start the Local API Server, and load a model first.');
                }
                if (!res.ok) {
                    throw new Error("Jan server at " + base + ' answered HTTP ' + res.status + '. Load a model in Jan first.');
                }
                const data = await res.json().catch(function() { return null; });
                const list = data && data.data;
                if (list && list.length && list[0].id) return list[0].id;
                throw new Error('No model is loaded in Jan. Load a model first, or set a Model ID in Settings → API Key.');
            }

            async function chatWithLocal(keys, openAiMsgs) {
                const base = ((keys.defaultBaseUrl || '').trim() || 'http://localhost:1337/v1').replace(/\/+$/, '');
                let model = (keys.defaultModel || '').trim();
                if (!model) model = await detectJanModel(base);
                let res;
                try {
                    res = await fetchWithTimeout(base + '/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: model, messages: stripImagesForLocal(openAiMsgs), stream: false })
                    }, 180000);
                } catch (e) {
                    throw new Error(requestFailed(base, e));
                }
                if (!res.ok) await throwForBadStatus(res);
                const text = extractOpenAiText(await res.json().catch(function() { return null; }));
                if (!text) throw new Error('Jan returned an empty reply. Try another prompt or model.');
                return text;
            }

            async function chatOpenAiCompatible(base, key, model, openAiMsgs) {
                let res;
                try {
                    res = await fetchWithTimeout(base + '/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                        body: JSON.stringify({ model: model, messages: openAiMsgs, stream: false })
                    }, 120000);
                } catch (e) {
                    throw new Error(requestFailed(base, e));
                }
                if (!res.ok) await throwForBadStatus(res);
                const text = extractOpenAiText(await res.json().catch(function() { return null; }));
                if (!text) throw new Error('The model returned an empty reply.');
                return text;
            }

            async function chatWithGemini(key, model, openAiMsgs) {
                const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key);
                let res;
                try {
                    res = await fetchWithTimeout(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents: toGeminiContents(openAiMsgs) })
                    }, 120000);
                } catch (e) {
                    throw new Error(requestFailed('generativelanguage.googleapis.com', e));
                }
                if (!res.ok) await throwForBadStatus(res);
                const data = await res.json().catch(function() { return null; });
                let text = '';
                try {
                    text = data.candidates[0].content.parts.filter(function(p) { return p.text; }).map(function(p) { return p.text; }).join('');
                } catch (e) {}
                if (!text) throw new Error('Gemini returned an empty reply.');
                return text;
            }

            async function chatWithClaude(key, model, openAiMsgs) {
                let res;
                try {
                    res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': key,
                            'anthropic-version': '2023-06-01',
                            'anthropic-dangerous-direct-browser-access': 'true'
                        },
                        body: JSON.stringify({ model: model, max_tokens: 2048, messages: toAnthropicMessages(openAiMsgs) })
                    }, 120000);
                } catch (e) {
                    throw new Error(requestFailed('api.anthropic.com', e));
                }
                if (!res.ok) await throwForBadStatus(res);
                const data = await res.json().catch(function() { return null; });
                let text = '';
                try {
                    text = data.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
                } catch (e) {}
                if (!text) throw new Error('Claude returned an empty reply.');
                return text;
            }

            async function callAssistant(modelKey, keys, history, files) {
                const def = modelDef(modelKey);
                const openAiMsgs = buildOpenAiMessages(history, files);
                switch (def.provider) {
                    case 'local':
                        return chatWithLocal(keys, openAiMsgs);
                    case 'openai':
                        return chatOpenAiCompatible('https://api.openai.com/v1', keys.openai, def.model, openAiMsgs);
                    case 'deepseek':
                        return chatOpenAiCompatible('https://api.deepseek.com', keys.deepseek, def.model, openAiMsgs);
                    case 'gemini':
                        return chatWithGemini(keys.gemini, def.model, openAiMsgs);
                    case 'anthropic':
                        return chatWithClaude(keys.claude, def.model, openAiMsgs);
                    default:
                        throw new Error('Unknown model.');
                }
            }

            // ===== BACKEND (optional account service) =====
            const API_BASE = '/api';

            // ===== AUTH (session via /api backend when present; guest otherwise) =====
            let currentUser = null;

            function ownerKey() {
                return currentUser ? ('user:' + (currentUser.id || currentUser.email)) : 'guest';
            }

            function applyOwner() {
                window.ChatBotStore.setOwner(ownerKey());
                conversations = window.ChatBotStore.loadConversations();
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
                stopGeneration();
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
                // Always reset the view after auth resolves so the history
                // shown always matches the active owner (guest or account).
                resetChatView();
                return user;
            }

            async function doSignOut(everywhere) {
                try {
                    await fetch(API_BASE + '/auth/logout', { method: 'POST', credentials: 'same-origin' });
                } catch (e) {}
                if (everywhere) {
                    try {
                        await fetch(API_BASE + '/auth/logout-all', { method: 'POST', credentials: 'same-origin' });
                    } catch (e) {}
                }
                currentUser = null;
                // Signed-out view is always empty: wipe the guest scratch store.
                window.ChatBotStore.clearConversations('guest');
                applyOwner();
                renderFooter();
                notifyAccountPanel();
                resetChatView();
            }

            async function deleteAccount() {
                if (!currentUser) return false;
                const owner = ownerKey();
                try {
                    await fetch(API_BASE + '/auth/account', { method: 'DELETE', credentials: 'same-origin' });
                } catch (e) {}
                window.ChatBotStore.clearConversations(owner);
                await doSignOut(false);
                return true;
            }

            window.ChatBotAuth = window.ChatBotAuth || {};
            window.ChatBotAuth.getUser = function() { return currentUser; };
            window.ChatBotAuth.signOut = function(everywhere) { return doSignOut(!!everywhere); };
            window.ChatBotAuth.deleteAccount = function() { return deleteAccount(); };

            refreshAuth();

            // ===== SIDEBAR FOOTER USER MENU (opens upward) =====
            const HELP_TEXT = 'Here is how to use ChatBot AI:\n\n'
                + '**Start chatting** — type below and press Enter. Use New chat to start over.\n\n'
                + '**History** — every chat is saved automatically. Rename with the pencil icon, delete with the trash icon, click any item to continue it.\n\n'
                + '**Models** — pick a model from the dropdown in the input box. Default uses your local Jan model. Cloud models (GPT-4o, Gemini, Claude, DeepSeek) need an API key in Settings → API Key.\n\n'
                + '**Attachments** — the + button can upload files, dictate voice, create image prompts, and attach plugin or skill tags. Attached files are sent to the model together with your message.\n\n'
                + '**Account** — sign in to keep a personal chat history on this device. Signing out clears the view; signing back in reloads your saved chats.';

            function showHelpChat() {
                activeConversationId = null;
                chatStarted = true;
                welcomeScreen.style.display = 'none';
                messagesWrapper.classList.add('visible');
                messagesWrapper.innerHTML = '';
                addMessage('assistant', HELP_TEXT);
                renderHistory();
                scrollToBottom();
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
                    // Folder name contains spaces, so it is percent-encoded here.
                    window.location.assign('./components/signup%20and%20signin/signup.html');
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
            const INPUT_MAX_HEIGHT = 260;

            function updateSendState() {
                // While a reply is streaming the button is the "Stop" control, so its
                // enabled state is managed by setStreaming() instead.
                if (isStreaming) return;
                const hasText = chatInput.value.trim() !== '' || attachedFiles.length > 0;
                btnSend.disabled = !hasText;
                btnSend.classList.toggle('active', hasText);
            }

            function autoGrowInput() {
                chatInput.style.height = 'auto';
                chatInput.style.height = Math.min(chatInput.scrollHeight, INPUT_MAX_HEIGHT) + 'px';
            }

            chatInput.addEventListener('input', function() {
                autoGrowInput();
                updateSendState();
            });

            // ===== CONVERSATION STORE (synced + persisted) =====
            function getActiveConversation() {
                for (let i = 0; i < conversations.length; i++) {
                    if (conversations[i].id === activeConversationId) return conversations[i];
                }
                return null;
            }

            function persistConversations() {
                window.ChatBotStore.saveConversations(conversations);
                renderHistory();
            }

            function makeTitle(raw) {
                const clean = (raw || '').replace(/\s+/g, ' ').trim();
                if (!clean) return 'Attached files';
                return clean.length > 42 ? clean.slice(0, 42) + '…' : clean;
            }

            function escHtml(s) {
                return String(s)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
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
                    buckets[conversationGroup(c.updatedAt || c.createdAt || Date.now())].push(c);
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

            function loadConversation(id) {
                let convo = null;
                for (let i = 0; i < conversations.length; i++) {
                    if (conversations[i].id === id) convo = conversations[i];
                }
                if (!convo) return;
                activeConversationId = id;
                setModelPicker(convo.model || 'default');
                    messagesWrapper.innerHTML = '';
                    (convo.messages || []).forEach(function(m, mi) {
                        addMessage(m.role === 'assistant' ? 'assistant' : 'user', m.content, { msgIndex: mi });
                    });

                if (convo.messages && convo.messages.length) {
                    chatStarted = true;
                    welcomeScreen.style.display = 'none';
                    messagesWrapper.classList.add('visible');
                } else {
                    chatStarted = false;
                    welcomeScreen.style.display = '';
                    messagesWrapper.classList.remove('visible');
                }
                renderHistory();
                scrollToBottom();
            }

            function startNewChat() {
                activeConversationId = null;
                chatStarted = false;
                welcomeScreen.style.display = '';
                messagesWrapper.classList.remove('visible');
                messagesWrapper.innerHTML = '';
                renderHistory();
                if (getBreakpoint() !== 'desktop') {
                    closeSidebar();
                }
                chatInput.focus();
            }

            function deleteConversation(id) {
                conversations = conversations.filter(function(c) { return c.id !== id; });
                if (activeConversationId === id) {
                    startNewChat();
                } else {
                    persistConversations();
                }
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
                function commit(save) {
                    if (done) return;
                    done = true;
                    if (save) {
                        const v = input.value.trim();
                        if (v) {
                            convo.title = v;
                            convo.updatedAt = Date.now();
                        }
                    }
                    persistConversations();
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

            function showKeyAlert(modelKey) {
                const def = modelDef(modelKey);
                if (keyAlertDesc) {
                    keyAlertDesc.textContent = def.label + ' needs an API key before it can be used. Add it in Settings → API Key, then try again.';
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
            // options.isRetry re-runs the last turn without appending the user message.
            async function sendMessage(text, options) {
                const opts = options || {};
                if (isStreaming) return;
                const raw = (text || '').trim();
                const hasFiles = attachedFiles.length > 0;
                if (!raw && !hasFiles && !opts.isRetry) return;

                // Gate: cloud models require a saved API key.
                if (!modelHasKey(currentModelKey)) {
                    showKeyAlert(currentModelKey);
                    setModelPicker('default');
                    const gated = getActiveConversation();
                    if (gated) {
                        gated.model = 'default';
                        persistConversations();
                    }
                    return;
                }

                let convo = getActiveConversation();
                if (!convo) {
                    convo = {
                        id: window.ChatBotStore.makeId(),
                        title: makeTitle(raw),
                        model: currentModelKey,
                        messages: [],
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    };
                    conversations.unshift(convo);
                    activeConversationId = convo.id;
                }
                convo.model = currentModelKey;

                if (!chatStarted) {
                    chatStarted = true;
                    welcomeScreen.style.display = 'none';
                    messagesWrapper.classList.add('visible');
                }

                let displayText = raw;
                if (hasFiles) {
                    const names = attachedFiles.map(function(f) { return f.name; }).join(', ');
                    displayText = (displayText ? displayText + '\n' : '') + '[Attached files: ' + names + ']';
                }
                if (!opts.isRetry) {
                    convo.messages.push({ role: 'user', content: displayText, ts: Date.now() });
                }
                // Last entry is always the user turn (a retry reuses the stored one).
                const userMsgIndex = convo.messages.length - 1;

                const filesSnapshot = attachedFiles.map(function(f) {
                    return { name: f.name, type: f.type, data: f.data };
                });
                attachedFiles.length = 0;
                const filePreviewArea = document.getElementById('filePreviewArea');
                if (filePreviewArea) {
                    filePreviewArea.innerHTML = '';
                    filePreviewArea.hidden = true;
                }

                // Add user message
                if (!opts.isRetry) addMessage('user', displayText, { msgIndex: userMsgIndex });
                persistConversations();

                // Clear input
                chatInput.value = '';
                autoGrowInput();
                updateSendState();

                activeRequestCtl = new AbortController();
                setStreaming(true);

                // "Thinking" dots while the provider call is in flight; the real
                // bubble is created as soon as there is something to show.
                typingIndicator.classList.add('visible');
                scrollToBottom();

                let reply = '';
                let cancelled = false;
                try {
                    reply = await callAssistant(currentModelKey, getApiKeys(), convo.messages, filesSnapshot);
                } catch (error) {
                    if (error && error.name === 'AbortError') {
                        cancelled = true;
                    } else {
                        reply = 'Sorry — ' + ((error && error.message) ? error.message : 'request failed.');
                    }
                }

                activeRequestCtl = null;
                typingIndicator.classList.remove('visible');

                // Stopped before any content arrived: drop the placeholder entirely
                // rather than leaving an empty "Stopped" bubble behind.
                if (cancelled) {
                    convo.updatedAt = Date.now();
                    persistConversations();
                    setStreaming(false);
                    scrollToBottom();
                    return;
                }

                // Bubble is created up-front so the answer streams straight into it.
                const ref = addMessage('assistant', '', { msgIndex: convo.messages.length });
                ref.setStreaming(true);

                // Word-by-word reveal. The button stays in "stop" mode until it ends.
                activeStream = createTypewriter(ref.textEl, reply, {
                    onPaint: function() {
                        if (isPinnedToBottom()) scrollToBottom(true);
                    },
                    onDone: function() {
                        activeStream = null;
                        ref.setStreaming(false);
                        convo.messages.push({ role: 'assistant', content: reply, ts: Date.now() });
                        convo.updatedAt = Date.now();
                        persistConversations();
                        setStreaming(false);
                        updateScrollAffordances();
                    },
                    onCancel: function() {
                        activeStream = null;
                        ref.setStreaming(false);
                        ref.markStopped();
                        convo.updatedAt = Date.now();
                        persistConversations();
                        setStreaming(false);
                    }
                });

                scrollToBottom();
            }

            // "Stop generating": kills the network request and freezes the typewriter.
            function stopGeneration() {
                if (activeRequestCtl) {
                    try { activeRequestCtl.abort(); } catch (e) {}
                    activeRequestCtl = null;
                }
                if (activeStream) {
                    activeStream.cancel();
                }
            }

            // Morph the send arrow into a stop square while a reply is in flight.
            function setStreaming(on) {
                    isStreaming = on;
                    btnSend.classList.toggle('is-stopping', on);
                    btnSend.disabled = false;
                    const label = on ? 'Stop generating' : 'Send message';
                    btnSend.setAttribute('aria-label', label);
                    btnSend.setAttribute('title', label);
                    // Lock the composer while an answer is arriving. readOnly is used
                    // instead of disabled so the caret and focus are never stolen
                    // from the user mid-answer.
                    chatInput.readOnly = !!on;
                    chatInput.setAttribute('aria-busy', on ? 'true' : 'false');
                    const composer = document.querySelector('.input-box');
                    if (composer) composer.classList.toggle('is-busy', !!on);
                    if (!on) {
                        btnSend.classList.remove('active');
                        updateSendState();
                    }
                }


            // Typewriter reveal. Reveals on word boundaries and accelerates over
            // time so long answers never feel like they are crawling.
            function createTypewriter(el, fullText, hooks) {
                const opts = hooks || {};
                const source = String(fullText == null ? '' : fullText);
                let shown = 0;
                let raf = 0;
                let finished = false;
                let lastTime = nowMs();
                const startedAt = lastTime;

                function paint() {
                    el.innerHTML = formatText(source.slice(0, shown));
                    if (opts.onPaint) opts.onPaint();
                }

                function step() {
                    const t = nowMs();
                    const dt = Math.max(0, t - lastTime);
                    lastTime = t;
                    const elapsed = (t - startedAt) / 1000;
                    // Starts around 300 chars/sec and ramps up quadratically.
                    let cps = 300 + elapsed * elapsed * 420;
                    if (source.length < 500) cps = Math.max(cps, 2600);
                    let target = Math.min(source.length, shown + Math.max(1, Math.round(cps * dt / 1000)));
                    if (target < source.length) {
                        const slice = source.slice(shown, target);
                        const nl = slice.lastIndexOf('\n');
                        const sp = slice.lastIndexOf(' ');
                        const cut = Math.max(nl, sp);
                        if (cut > 0) target = shown + cut + 1;
                    }
                    shown = target;
                    paint();
                    if (shown >= source.length) {
                        settle();
                        return;
                    }
                    raf = requestAnimationFrame(step);
                }

                function settle() {
                    if (finished) return;
                    finished = true;
                    if (raf) cancelAnimationFrame(raf);
                    raf = 0;
                    if (opts.onDone) opts.onDone();
                }

                const api = {
                    cancel: function() {
                        if (finished) return;
                        finished = true;
                        if (raf) cancelAnimationFrame(raf);
                        raf = 0;
                        if (opts.onCancel) opts.onCancel();
                    }
                };

                // Zero-length reply: render immediately, no animation.
                if (!source) {
                    paint();
                    if (opts.onDone) opts.onDone();
                } else {
                    raf = requestAnimationFrame(step);
                }

                return api;
            }

            function nowMs() {
                return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            }

            const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
            const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
            const ICON_THUMBS_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88"/></svg>';
            const ICON_THUMBS_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88"/></svg>';
            const ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
            const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

            function addMessage(role, text, meta) {
                const info = meta || {};
                const msg = document.createElement('div');
                msg.className = 'message ' + role;

                const isUser = role === 'user';
                const avatarIcon = isUser
                    ? 'U'
                    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
                const senderName = isUser ? 'You' : 'ChatBot AI';
                const senderTag = isUser ? 'user' : 'assistant';

                msg.innerHTML = '<div class="message-content">'
                    + '<div class="message-avatar">' + avatarIcon + '</div>'
                    + '<div class="message-body">'
                    + '<div class="message-sender">' + senderName + '</div>'
                    + '<div class="message-text">' + (text ? formatText(text) : '') + '</div>'
                    + '<div class="message-actions" hidden>'
                    + (isUser ? '<button class="btn-msg-action" data-msg-action="edit" aria-label="Edit">' + ICON_EDIT + '<span>Edit</span></button>' : '')
                    + '<button class="btn-msg-action btn-msg-copy" aria-label="Copy">' + ICON_COPY + '<span>Copy</span></button>'
                    + (isUser ? '' : '<button class="btn-msg-action" data-msg-action="regenerate" aria-label="Regenerate">' + ICON_REFRESH + '<span>Regenerate</span></button>')
                    + (isUser ? '' : '<button class="btn-msg-action" data-msg-action="like" aria-label="Like">' + ICON_THUMBS_UP + '</button>')
                    + (isUser ? '' : '<button class="btn-msg-action" data-msg-action="dislike" aria-label="Dislike">' + ICON_THUMBS_DOWN + '</button>')
                    + '</div>'
                    + '</div></div>';

                messagesWrapper.appendChild(msg);

                // Streaming replies grow after insertion, so keep the source text
                // here and re-render on each update.
                let currentText = text || '';
                const textNode = msg.querySelector('.message-text');
                const actionsNode = msg.querySelector('.message-actions');

                function render() {
                    textNode.innerHTML = currentText ? formatText(currentText) : '';
                }

                // Copy button
                const copyBtn = msg.querySelector('.btn-msg-copy');
                if (copyBtn) {
                    const label = copyBtn.querySelector('span');
                    copyBtn.addEventListener('click', function() {
                        const done = function() {
                            copyBtn.innerHTML = ICON_CHECK + '<span>Copied</span>';
                            copyBtn.classList.add('copied');
                            setTimeout(function() {
                                copyBtn.innerHTML = ICON_COPY + '<span>Copy</span>';
                                copyBtn.classList.remove('copied');
                            }, 1800);
                        };
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            navigator.clipboard.writeText(currentText).then(done, function() {});
                        } else {
                            const ta = document.createElement('textarea');
                            ta.value = currentText;
                            document.body.appendChild(ta);
                            ta.select();
                            try { document.execCommand('copy'); } catch (e) {}
                            document.body.removeChild(ta);
                            done();
                        }
                    });
                }

                // Like / dislike are mutually exclusive.
                msg.querySelectorAll('[data-msg-action]').forEach(function(btn) {
                    const action = btn.getAttribute('data-msg-action');
                    if (action !== 'like' && action !== 'dislike') return;
                    btn.addEventListener('click', function() {
                        const wasOn = btn.classList.contains('on');
                        msg.querySelectorAll('[data-msg-action="like"],[data-msg-action="dislike"]').forEach(function(b) {
                            b.classList.remove('on');
                        });
                        if (!wasOn) btn.classList.add('on');
                    });
                });

                msg.dataset.role = senderTag;
                // Index inside the active conversation, so the Edit action knows
                // exactly which turn to rewind to.
                if (typeof info.msgIndex === 'number') msg.dataset.mi = String(info.msgIndex);

                return {
                    element: msg,
                    textEl: textNode,
                    append: function(chunk) {
                        currentText += chunk;
                        render();
                    },
                    setText: function(next) {
                        currentText = next == null ? '' : next;
                        render();
                    },
                    // Hide the action row while the answer is still arriving.
                    setStreaming: function(on) {
                        if (actionsNode) actionsNode.hidden = !!on;
                        msg.classList.toggle('is-streaming', !!on);
                    },
                    // Left by a user-initiated stop: keep the partial text, show actions.
                    markStopped: function() {
                        if (actionsNode) actionsNode.hidden = false;
                        msg.classList.remove('is-streaming');
                        if (!msg.querySelector('.message-stopped')) {
                            if (!currentText) {
                                const note = document.createElement('div');
                                note.className = 'message-stopped';
                                note.textContent = 'Stopped';
                                textNode.appendChild(note);
                            } else {
                                const note = document.createElement('div');
                                note.className = 'message-stopped';
                                note.textContent = 'Stopped';
                                msg.querySelector('.message-body').appendChild(note);
                            }
                        }
                    }
                };
            }

            // ===== MARKDOWN =====
            // Self-contained renderer: no external library. Code fences are pulled
            // out first and re-inserted last so their content can never be
            // interpreted as Markdown (and so the Copy button keeps working across
            // re-renders, since the original source is cached in a <template>).
            const RE_FENCE = /^([ \t]*)```([^\n`]*)\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
            // Used while an answer is still streaming: a fence with no closer yet.
            const RE_FENCE_OPEN = /(^|\n)([ \t]*)```([^\n`]*)\n([\s\S]*)$/;
            const RE_INLINE_CODE = /`([^`\n]+)`/g;
            const RE_HEADING = /^(#{1,6})\s+(.*)$/;
            const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
            const RE_QUOTE = /^>\s?(.*)$/;
            const RE_BOLD = /\*\*(.+?)\*\*/g;
            const RE_ITALIC = /(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g;
            const RE_STRIKE = /~~(.+?)~~/g;
            const RE_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
            const RE_BARE_URL = /(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g;

            const PLACEHOLDER_PREFIX = '\u0000md';
            const LANGUAGE_LABELS = {
                js: 'JavaScript', jsx: 'JSX', javascript: 'JavaScript', ts: 'TypeScript',
                tsx: 'TSX', typescript: 'TypeScript', py: 'Python', python: 'Python',
                rb: 'Ruby', ruby: 'Ruby', go: 'Go', golang: 'Go', rs: 'Rust', rust: 'Rust',
                java: 'Java', kt: 'Kotlin', kotlin: 'Kotlin', c: 'C', cpp: 'C++', 'c++': 'C++',
                cs: 'C#', 'c#': 'C#', php: 'PHP', swift: 'Swift', sh: 'Shell', bash: 'Shell',
                shell: 'Shell', zsh: 'Shell', ps1: 'PowerShell', powershell: 'PowerShell',
                sql: 'SQL', html: 'HTML', xml: 'XML', css: 'CSS', scss: 'SCSS', sass: 'Sass',
                less: 'Less', json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML',
                toml: 'TOML', ini: 'INI', md: 'Markdown', markdown: 'Markdown',
                dockerfile: 'Dockerfile', diff: 'Diff', lua: 'Lua', r: 'R', dart: 'Dart',
                vue: 'Vue', svelte: 'Svelte', graphql: 'GraphQL', gql: 'GraphQL', text: 'Text'
            };

            function escHtml(value) {
                return String(value == null ? '' : value)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
            }

            function languageLabel(lang) {
                const key = String(lang || '').trim().toLowerCase().split(/[\s:+-]/)[0];
                if (!key) return 'Code';
                return LANGUAGE_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1);
            }

            // Inline-level formatting. Input must already be HTML-escaped.
            function inlineMd(escaped) {
                const codes = [];
                // Pull inline code out first so `**` inside a span stays literal.
                let out = String(escaped).replace(RE_INLINE_CODE, function(_, code) {
                    codes.push(code);
                    return PLACEHOLDER_PREFIX + 'c' + (codes.length - 1) + '\u0001';
                });

                out = out.replace(RE_BOLD, '<strong>$1</strong>');
                out = out.replace(RE_ITALIC, function(_, lead, body) {
                    return lead + '<em>' + body + '</em>';
                });
                out = out.replace(RE_STRIKE, '<del>$1</del>');
                out = out.replace(RE_LINK, function(_, label, href) {
                    const safe = escHtml(href);
                    return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + (label || safe) + '</a>';
                });
                out = out.replace(RE_BARE_URL, function(_, lead, url) {
                    return lead + '<a href="' + escHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escHtml(url) + '</a>';
                });

                return out.replace(new RegExp(PLACEHOLDER_PREFIX + 'c(\\d+)\u0001', 'g'), function(_, i) {
                    return '<code>' + codes[Number(i)] + '</code>';
                });
            }

            // Block-level renderer operating on raw, unescaped text.
            // `fences` is threaded through recursion so a code block nested in a
            // list item or blockquote resolves against the same table.
            function renderBlocks(text, fences) {
                const source = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
                const pool = fences || [];
                let body = source.replace(RE_FENCE, function(_, indent, lang, code) {
                    pool.push({ lang: lang || '', code: code.replace(/\n$/, '') });
                    // Keep the original indentation so a fenced block nested in a
                    // list item stays inside that item.
                    return indent + PLACEHOLDER_PREFIX + 'f' + (pool.length - 1) + '\u0001\n';
                });
                // A still-open fence is normal mid-stream; render it as a code block
                // instead of leaving raw backticks on screen.
                body = body.replace(RE_FENCE_OPEN, function(_, lead, indent, lang, code) {
                    pool.push({ lang: lang || '', code: code.replace(/\n$/, '') });
                    return lead + indent + PLACEHOLDER_PREFIX + 'f' + (pool.length - 1) + '\u0001';
                });

                const lines = body.split('\n');
                const out = [];
                let i = 0;

                function flushParagraph(buf) {
                    if (!buf.length) return;
                    out.push('<p>' + inlineMd(escHtml(buf.join('\n')).replace(/\n/g, '<br>')) + '</p>');
                }

                while (i < lines.length) {
                    const line = lines[i];

                    // Fence placeholder on its own line.
                    const ph = line.trim().match(new RegExp('^' + PLACEHOLDER_PREFIX + 'f(\\d+)\u0001$'));
                    if (ph) {
                        out.push(codeBlockHtml(pool[Number(ph[1])]));
                        i++;
                        continue;
                    }

                    if (!line.trim()) { i++; continue; }

                    if (RE_HR.test(line)) {
                        out.push('<hr>');
                        i++;
                        continue;
                    }

                    const heading = line.match(RE_HEADING);
                    if (heading) {
                        const level = heading[1].length;
                        out.push('<h' + level + '>' + inlineMd(escHtml(heading[2].trim())) + '</h' + level + '>');
                        i++;
                        continue;
                    }

                    if (RE_QUOTE.test(line)) {
                        const quote = [];
                        while (i < lines.length && (RE_QUOTE.test(lines[i]) || (quote.length && lines[i].trim()))) {
                            const m = lines[i].match(RE_QUOTE);
                            quote.push(m ? m[1] : lines[i].trim());
                            i++;
                        }
                        out.push('<blockquote>' + renderBlocks(quote.join('\n'), pool) + '</blockquote>');
                        continue;
                    }

                    const listStart = matchListItem(line);
                    if (listStart) {
                        const list = renderList(lines, i, listStart.indent, pool);
                        out.push(list.html);
                        i = list.end;
                        continue;
                    }

                    // GFM pipe table
                    if (line.indexOf('|') !== -1 && i + 1 < lines.length && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') !== -1) {
                        const header = splitTableRow(line);
                        const aligns = splitTableRow(lines[i + 1]).map(function(cell) {
                            const c = cell.trim();
                            const left = c.charAt(0) === ':';
                            const right = c.charAt(c.length - 1) === ':';
                            if (left && right) return 'center';
                            if (right) return 'right';
                            if (left) return 'left';
                            return '';
                        });
                        i += 2;
                        const rows = [];
                        while (i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim()) {
                            rows.push(splitTableRow(lines[i]));
                            i++;
                        }
                        const th = header.map(function(cell, ci) {
                            return '<th' + alignAttr(aligns[ci]) + '>' + inlineMd(escHtml(cell)) + '</th>';
                        }).join('');
                        const bodyRows = rows.map(function(row) {
                            return '<tr>' + row.map(function(cell, ci) {
                                return '<td' + alignAttr(aligns[ci]) + '>' + inlineMd(escHtml(cell)) + '</td>';
                            }).join('') + '</tr>';
                        }).join('');
                        out.push('<div class="md-table-wrap"><table><thead><tr>' + th + '</tr></thead><tbody>' + bodyRows + '</tbody></table></div>');
                        continue;
                    }

                    // Paragraph (consume until a blank line or a new block marker).
                    const para = [];
                    while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) {
                        para.push(lines[i].trim());
                        i++;
                    }
                    flushParagraph(para);
                }

                return out.join('');
            }

            function isBlockStart(lines, index) {
                const line = lines[index] || '';
                if (RE_HEADING.test(line) || RE_HR.test(line) || RE_QUOTE.test(line)) return true;
                if (matchListItem(line)) return true;
                if (line.trim().indexOf(PLACEHOLDER_PREFIX) === 0) return true;
                if (line.indexOf('|') !== -1 && index + 1 < lines.length && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[index + 1]) && lines[index + 1].indexOf('-') !== -1) return true;
                return false;
            }

            // A list marker plus its indentation, or null.
            function matchListItem(line) {
                const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
                if (ul) return { indent: ul[1].length, ordered: false, num: 1, text: ul[2] };
                const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
                if (ol) return { indent: ol[1].length, ordered: true, num: Number(ol[2]), text: ol[3] };
                return null;
            }

            // Renders one <ul>/<ol> level and returns the index of the first line
            // that is no longer part of it. Recurses for indented sub-lists.
            function renderList(lines, start, baseIndent, pool) {
                const head = matchListItem(lines[start]);
                const ordered = head.ordered;
                const startAttr = ordered && head.num !== 1 ? ' start="' + head.num + '"' : '';
                const tag = ordered ? 'ol' : 'ul';
                let i = start;
                const items = [];

                while (i < lines.length) {
                    const m = matchListItem(lines[i]);
                    if (!m || m.indent !== baseIndent || m.ordered !== ordered) break;

                    const parts = [m.text];
                    const subLists = [];
                    i++;

                    while (i < lines.length) {
                        const l = lines[i];
                        if (!l.trim()) {
                            // A blank line only continues the list if indented
                            // content or another marker follows.
                            let j = i;
                            while (j < lines.length && !lines[j].trim()) j++;
                            if (j < lines.length && (matchListItem(lines[j]) || /^\s{2,}\S/.test(lines[j]))) {
                                i = j;
                                continue;
                            }
                            i = j;
                            break;
                        }
                        const nm = matchListItem(l);
                        if (nm && nm.indent <= baseIndent) break;
                        if (nm) {
                            const sub = renderList(lines, i, nm.indent, pool);
                            subLists.push(sub.html);
                            i = sub.end;
                            continue;
                        }
                        // An indented code block belongs to this item, not after it.
                        if (/^\s+\u0000md/.test(l)) {
                            parts.push(l.trim());
                            i++;
                            continue;
                        }
                        if (isBlockStart(lines, i)) break;
                        parts.push(l.trim());
                        i++;
                    }

                    const paragraph = renderBlocks(parts.join('\n'), pool);
                    // A lone <p> wrapper is noise inside a list item.
                    const single = paragraph.match(/^<p>([\s\S]*)<\/p>$/);
                    items.push('<li>' + (single ? single[1] : paragraph) + subLists.join('') + '</li>');
                }

                return { html: '<' + tag + startAttr + '>' + items.join('') + '</' + tag + '>', end: i };
            }

            function splitTableRow(line) {
                return line
                    .replace(/^\s*\|/, '')
                    .replace(/\|\s*$/, '')
                    .split('|')
                    .map(function(c) { return c.trim(); });
            }

            function alignAttr(align) {
                return align ? ' style="text-align:' + align + '"' : '';
            }

            // A code block always renders dark, with a language chip and a copy button.
            function codeBlockHtml(block) {
                const raw = escHtml(block.code);
                const label = languageLabel(block.lang);
                return '<div class="code-block">'
                    + '<div class="code-block-head">'
                    + '<span class="code-lang">' + escHtml(label) + '</span>'
                    + '<button class="code-copy" type="button" aria-label="Copy code">'
                    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
                    + '<span>Copy</span></button>'
                    + '</div>'
                    + '<pre class="code-block-body"><code class="code-block-code">' + highlightCode(block.code, block.lang) + '</code></pre>'
                    // Pristine copy of the source, so Copy stays correct even though
                    // innerHTML is rebuilt on every streaming frame.
                    + '<template class="code-raw">' + raw + '</template>'
                    + '</div>';
            }

            // Small, dependency-free highlighter. Deliberately conservative: it only
            // marks up what it is sure about, so unknown languages still read well.
            // Strings are matched atomically from left to right, so a `//` inside a
            // string is never mistaken for a comment.
            const HL = {
                comments: /\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->|#[^\n]*/,
                strings: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/,
                numbers: /\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/,
                keywords: /(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|import|export|from|default|as|static|get|set|void|delete|null|undefined|true|false|interface|type|enum|implements|public|private|protected|readonly|package|struct|impl|fn|pub|mut|def|elif|lambda|pass|raise|with|asyncio|self|None|True|False|SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|JOIN|ON|GROUP|BY|ORDER|LIMIT|AND|OR|NOT|NULL|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|INDEX|CONSTRAINT|USING)(?![\w$])/
            };

            function highlightCode(code, lang) {
                const language = String(lang || '').trim().toLowerCase();
                let rules = [];
                const shell = /^(sh|bash|zsh|shell|console|terminal|powershell|ps1|fish)$/.test(language);
                const html = /^(html|xml|vue|svelte|svg)$/.test(language);

                if (shell) {
                    rules.push([/#[^\n]*/, 'com', false]);
                    rules.push([/"(?:\\.|[^"\\\n])*"|'[^'\n]*'/, 'str', false]);
                    rules.push([/\$[A-Za-z_]\w*|\$\{[^}]*\}/, 'var', false]);
                } else {
                    rules.push([HL.comments, 'com', false]);
                    rules.push([HL.strings, 'str', false]);
                    if (html) {
                        rules.push([/<\/?[A-Za-z][\w:-]*/, 'tag', false]);
                        rules.push([/\/?>/, 'tag', false]);
                    }
                    // needsBoundary: never highlight inside a longer identifier
                    // (e.g. the "in" inside "plain").
                    rules.push([HL.keywords, 'kw', true]);
                    rules.push([HL.numbers, 'num', true]);
                }

                // An unlabeled fence is as likely to be prose or config as code, so
                // skip keyword coloring rather than turn words like "for" pink.
                if (!language) {
                    rules = rules.filter(function(rule) { return rule[1] !== 'kw'; });
                }

                // Sticky copies: matching at lastIndex avoids slicing the source
                // once per character, which matters while a long block streams.
                return runHl(code, rules.map(function(rule) {
                    return [new RegExp(rule[0].source, 'y'), rule[1], rule[2]];
                }));
            }

            // Single-pass tokenizer: at each position take whichever rule matches
            // first, so patterns can overlap without clobbering each other.
            function runHl(code, rules) {
                let out = '';
                let plain = '';
                let i = 0;

                function flush() {
                    if (plain) {
                        out += escHtml(plain);
                        plain = '';
                    }
                }

                while (i < code.length) {
                    const atBoundary = i === 0 || !/[\w$]/.test(code[i - 1]);
                    let bestClass = null;
                    let bestIndex = 0;
                    for (let r = 0; r < rules.length; r++) {
                        const re = rules[r][0];
                        if (rules[r][2] && !atBoundary) continue;
                        re.lastIndex = i;
                        const m = re.exec(code);
                        if (m && m[0].length) {
                            bestClass = rules[r][1];
                            bestIndex = m[0].length;
                            break;
                        }
                    }
                    if (bestClass) {
                        flush();
                        out += '<span class="tok-' + bestClass + '">' + escHtml(code.substr(i, bestIndex)) + '</span>';
                        i += bestIndex;
                    } else {
                        plain += code[i];
                        i++;
                    }
                }
                flush();
                return out;
            }

            // Single entry point used by every message renderer.
            function formatText(text) {
                if (!text) return '';
                return renderBlocks(text);
            }

            // Delegated so copy buttons keep working after innerHTML re-renders.
            messagesWrapper.addEventListener('click', function(e) {
                const codeBtn = e.target.closest('.code-copy');
                if (codeBtn) {
                    const block = codeBtn.closest('.code-block');
                    const tpl = block && block.querySelector('template.code-raw');
                    const raw = tpl ? tpl.innerHTML : '';
                    const label = codeBtn.querySelector('span');
                    const done = function() {
                        codeBtn.classList.add('copied');
                        if (label) label.textContent = 'Copied';
                        setTimeout(function() {
                            codeBtn.classList.remove('copied');
                            if (label) label.textContent = 'Copy';
                        }, 1800);
                    };
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(raw).then(done, function() {});
                    } else {
                        const ta = document.createElement('textarea');
                        ta.value = raw;
                        document.body.appendChild(ta);
                        ta.select();
                        try { document.execCommand('copy'); } catch (e) {}
                        document.body.removeChild(ta);
                        done();
                    }
                    return;
                }

                const regen = e.target.closest('[data-msg-action="regenerate"]');
                if (regen) { regenerateLast(); return; }

                const editBtn = e.target.closest('[data-msg-action="edit"]');
                if (editBtn) { editTurn(editBtn.closest('.message')); }
            });

            // Re-open an earlier user turn for revision: the original text (and
            // every reply after it) is pulled back out so the user can rewrite
            // and resend from that point.
            function editTurn(node) {
                if (isStreaming || !node) return;
                const convo = getActiveConversation();
                if (!convo || !convo.messages || !convo.messages.length) return;

                // Prefer the index recorded at render time; fall back to matching
                // the nth user bubble so older/foreign renders still work.
                let idx = node.dataset.mi != null ? parseInt(node.dataset.mi, 10) : -1;
                if (idx < 0 || idx >= convo.messages.length) {
                    const userNodes = messagesWrapper.querySelectorAll('.message.user');
                    const nth = Array.prototype.indexOf.call(userNodes, node);
                    if (nth < 0) return;
                    let seen = -1;
                    for (let k = 0; k < convo.messages.length; k++) {
                        if (convo.messages[k].role === 'user') {
                            seen++;
                            if (seen === nth) { idx = k; break; }
                        }
                    }
                    if (idx < 0) return;
                }

                const original = convo.messages[idx].content || '';

                // Locate the target bubble FIRST, so a stale reference aborts before
                // anything is mutated. Removal is driven by DOM order, which stays
                // correct even for nodes rendered before data-mi existed.
                const nodes = messagesWrapper.querySelectorAll('.message');
                let from = -1;
                for (let k = 0; k < nodes.length; k++) {
                    if (nodes[k] === node) { from = k; break; }
                }
                if (from < 0) return;

                // Both stores are now known to line up: drop the stored turn plus
                // everything after it, then the matching bubbles.
                convo.messages = convo.messages.slice(0, idx);
                for (let k = nodes.length - 1; k >= from; k--) nodes[k].remove();

                // Back to the empty state if this was the only turn left.
                if (!convo.messages.length) {
                    chatStarted = false;
                    welcomeScreen.style.display = '';
                    messagesWrapper.classList.remove('visible');
                }

                renderHistory();
                persistConversations();

                chatInput.value = original;
                autoGrowInput();
                updateSendState();
                chatInput.focus();
                // Put the caret at the end so the user can keep typing immediately.
                const len = chatInput.value.length;
                try { chatInput.setSelectionRange(len, len); } catch (err) {}
            }

            // Re-ask the model using the conversation up to (but not including) the
            // last assistant turn, then replace that turn's bubble in place.
            function regenerateLast() {
                if (isStreaming) return;
                const convo = getActiveConversation();
                if (!convo || !convo.messages.length) return;
                let lastUserIdx = -1;
                for (let k = convo.messages.length - 1; k >= 0; k--) {
                    if (convo.messages[k].role === 'user') { lastUserIdx = k; break; }
                }
                if (lastUserIdx === -1) return;
                // Drop the stale assistant reply so the retry is not duplicated.
                convo.messages = convo.messages.slice(0, lastUserIdx + 1);

                const nodes = messagesWrapper.querySelectorAll('.message.assistant');
                if (nodes.length) nodes[nodes.length - 1].remove();

                sendMessage('', { isRetry: true });
            }

            function isPinnedToBottom() {
                return chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 120;
            }

            // instant=true skips the smooth behavior (used while streaming).
            function scrollToBottom(instant) {
                requestAnimationFrame(function() {
                    if (instant) chatArea.scrollTop = chatArea.scrollHeight;
                    else chatArea.scrollTo({ top: chatArea.scrollHeight, behavior: 'smooth' });
                    updateScrollAffordances();
                });
            }

            function updateScrollAffordances() {
                if (!btnScrollBottom) return;
                const distance = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight;
                btnScrollBottom.classList.toggle('visible', distance > 200);
            }

            // Send button doubles as the Stop control while a reply is streaming.
            btnSend.addEventListener('click', function() {
                if (isStreaming) {
                    stopGeneration();
                    return;
                }
                sendMessage(chatInput.value);
            });

            // Enter to send (Shift+Enter for newline)
            chatInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (isStreaming) return;
                    if (this.value.trim() || attachedFiles.length) {
                        sendMessage(this.value);
                    }
                }
            });

            // ===== QUICK ACTIONS =====
            // Read the label from the inner span so the icon is never used as text.
            quickActions.forEach(function(btn) {
                btn.addEventListener('click', function() {
                    const labelNode = this.querySelector('.quick-action-text') || this;
                    const query = labelNode.textContent.trim();
                    chatInput.value = query;
                    autoGrowInput();
                    updateSendState();
                    sendMessage(query);
                });
            });
            updateSendState();

            // ===== SCROLL TO BOTTOM FAB =====
            if (btnScrollBottom) {
                btnScrollBottom.addEventListener('click', function() {
                    scrollToBottom(false);
                });
                chatArea.addEventListener('scroll', function() {
                    updateScrollAffordances();
                }, { passive: true });
                window.addEventListener('resize', function() {
                    updateScrollAffordances();
                });
            }

            // ===== HISTORY: select / rename / delete (delegated, persisted) =====
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

            // Initial paint from persisted store.
            setModelPicker('default');
            renderHistory();

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

            // Header theme toggle: flips the current appearance and keeps the
            // settings dropdown select in sync via applyTheme/syncAppearanceSelect.
            if (btnThemeToggle) {
                btnThemeToggle.addEventListener('click', function() {
                    const isLight = document.body.classList.contains('light');
                    applyTheme(isLight ? 'dark' : 'light');
                    btnThemeToggle.setAttribute(
                        'aria-label',
                        isLight ? 'Switch to light mode' : 'Switch to dark mode'
                    );
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
                        // Gate: keyless cloud models cannot be used.
                        if (!modelHasKey(key)) {
                            closeModelDropdown();
                            showKeyAlert(key);
                            return;
                        }
                        setModelPicker(key);
                        const convo = getActiveConversation();
                        if (convo) {
                            convo.model = currentModelKey;
                            persistConversations();
                        }
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
                    files.forEach(function(file) {
                        fileToBase64(file).then(function(base64) {
                            attachedFiles.push({
                                name: file.name,
                                type: file.type,
                                data: base64
                            });
                            renderFilePreview(file);
                        }).catch(function() {});
                    });
                    fileInput.value = '';
                });
            }

            function fileToBase64(file) {
                return new Promise(function(resolve, reject) {
                    const reader = new FileReader();
                    reader.onload = function() { resolve(reader.result.split(',')[1]); };
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
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
                settingsMenuItems.forEach(function(el) {
                    el.classList.toggle('active', el.getAttribute('data-panel') === key);
                });
                showSettingsPanel(key);
                if (key === 'account') refreshAccountPanel();
            };

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
                    if (confirm('Delete your account permanently? Its saved conversations will be removed from this device.')) {
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

            // ===== API KEY SETTINGS (5 providers, persisted in ChatBotStore) =====
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
                    if (keyInput) keyInput.value = keys[provider] || '';
                    if (baseInput) baseInput.value = keys.defaultBaseUrl || '';
                    if (modelInput) modelInput.value = keys.defaultModel || '';
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
                        if (provider === 'default') {
                            all.defaultBaseUrl = baseInput ? baseInput.value.trim() : '';
                            all.defaultModel = modelInput ? modelInput.value.trim() : '';
                        } else if (keyInput) {
                            all[provider] = keyInput.value.trim();
                        }
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
                            if (provider === 'default') {
                                all.defaultBaseUrl = '';
                                all.defaultModel = '';
                                if (baseInput) baseInput.value = '';
                                if (modelInput) modelInput.value = '';
                            } else {
                                all[provider] = '';
                                if (keyInput) keyInput.value = '';
                            }
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

