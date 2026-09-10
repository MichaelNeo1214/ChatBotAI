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
            const historyItems = document.querySelectorAll('.history-item');
            const quickActions = document.querySelectorAll('.quick-action');
            const btnModelDropdown = document.getElementById('btnModelDropdown');
            const modelDropdown = document.getElementById('modelDropdown');
            const modelOptions = document.querySelectorAll('.model-option');
            const currentModel = document.getElementById('currentModel');
            const btnSignIn = document.getElementById('btnSignIn');
            const account = document.getElementById('account');
            const accountName = document.getElementById('accountName');
            const btnSignOut = document.getElementById('btnSignOut');


            
            // State
            let chatStarted = false;
            let currentConversationId = null;
            let inFlight = null;
            const attachedFiles = [];

            // ===== BACKEND =====
            const API_BASE = '/api';

            /**
             * POSTs a message and yields assistant text as it streams back.
             * The server speaks Server-Sent Events: meta, delta*, then done|error.
             */
            async function streamChat(text, onMeta, onDelta) {
                const controller = new AbortController();
                inFlight = controller;

                const response = await fetch(API_BASE + '/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    signal: controller.signal,
                    body: JSON.stringify(
                        currentConversationId
                            ? { message: text, conversationId: currentConversationId, model: currentModel.textContent.trim() }
                            : { message: text, model: currentModel.textContent.trim() }
                    )
                });

                if (!response.ok) {
                    const detail = await response.json().catch(function() { return null; });
                    throw new Error((detail && detail.error && detail.error.message) || ('Request failed with status ' + response.status));
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                for (;;) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    buffer += decoder.decode(chunk.value, { stream: true });

                    // Events are separated by a blank line and can split across chunks.
                    let boundary = buffer.indexOf('\n\n');
                    while (boundary !== -1) {
                        const raw = buffer.slice(0, boundary);
                        buffer = buffer.slice(boundary + 2);
                        boundary = buffer.indexOf('\n\n');

                        let name = 'message';
                        let data = '';
                        raw.split('\n').forEach(function(line) {
                            if (line.indexOf('event:') === 0) name = line.slice(6).trim();
                            else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
                        });
                        if (!data) continue;

                        const payload = JSON.parse(data);
                        if (name === 'meta') onMeta(payload);
                        else if (name === 'delta') onDelta(payload.text);
                        else if (name === 'error') throw new Error(payload.message);
                    }
                }
            }

            // ===== ACCOUNT =====
            function renderAccount(user) {
                const signedIn = !!user;
                account.hidden = !signedIn;
                btnSignIn.hidden = signedIn;
                accountName.textContent = signedIn ? user.name : '';
                accountName.title = signedIn ? user.email : '';
            }

            fetch(API_BASE + '/auth/me', { credentials: 'same-origin' })
                .then(function(r) { return r.json(); })
                .then(function(d) { renderAccount(d.user); })
                .catch(function() { renderAccount(null); });

            btnSignOut.addEventListener('click', function() {
                fetch(API_BASE + '/auth/logout', { method: 'POST', credentials: 'same-origin' })
                    .finally(function() { window.location.reload(); });
            });

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
                const hasText = chatInput.value.trim() !== '' || attachedFiles.length > 0;
                btnSend.disabled = !hasText;
                btnSend.classList.toggle('active', hasText);
            }

            chatInput.addEventListener('input', function() {
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 200) + 'px';
                updateSendState();
            });

            // ===== SEND MESSAGE =====
            function sendMessage(text) {
                if ((!text || text.trim() === '') && attachedFiles.length === 0) return;

                if (!chatStarted) {
                    chatStarted = true;
                    welcomeScreen.style.display = 'none';
                    messagesWrapper.classList.add('visible');
                }

                let outText = (text || '').trim();
                if (attachedFiles.length > 0) {
                    const names = attachedFiles.map(function(f) { return f.name; }).join(', ');
                    outText = (outText ? outText + '\n' : '') + '[Attached files: ' + names + ']';
                }

                // Add user message
                addMessage('user', outText);

                // Clear input + attachments
                chatInput.value = '';
                chatInput.style.height = 'auto';
                attachedFiles.length = 0;
                const filePreviewArea = document.getElementById('filePreviewArea');
                if (filePreviewArea) {
                    filePreviewArea.innerHTML = '';
                    filePreviewArea.hidden = true;
                }
                updateSendState();

                // Show typing
                typingIndicator.classList.add('visible');
                scrollToBottom();

                let reply = null;
                streamChat(
                    outText,
                    function onMeta(meta) {
                        currentConversationId = meta.conversationId;
                    },
                    function onDelta(chunk) {
                        if (reply === null) {
                            typingIndicator.classList.remove('visible');
                            reply = addMessage('assistant', '');
                        }
                        reply.append(chunk);
                        scrollToBottom();
                    }
                ).catch(function(error) {
                    typingIndicator.classList.remove('visible');
                    const message = 'Sorry — ' + error.message;
                    if (reply === null) addMessage('assistant', message);
                    else reply.setText(message);
                    scrollToBottom();
                }).finally(function() {
                    typingIndicator.classList.remove('visible');
                    inFlight = null;
                    scrollToBottom();
                });
            }

            function addMessage(role, text) {
                const msg = document.createElement('div');
                msg.className = 'message ' + role;

                const avatarIcon = role === 'user'
                    ? 'U'
                    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

                const senderName = role === 'user' ? 'You' : 'ChatBot AI';

                const formattedText = formatText(text);

                msg.innerHTML = '<div class="message-content">'
                    + '<div class="message-avatar">' + avatarIcon + '</div>'
                    + '<div class="message-body">'
                    + '<div class="message-sender">' + senderName + '</div>'
                    + '<div class="message-text">' + formattedText + '</div>'
                    + '<div class="message-actions">'
                    + '<button class="btn-msg-action" aria-label="Copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</button>'
                    + '<button class="btn-msg-action" aria-label="Like"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88"/></svg></button>'
                    + '<button class="btn-msg-action" aria-label="Dislike"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88"/></svg></button>'
                    + '</div>'
                    + '</div></div>';

                messagesWrapper.appendChild(msg);

                // Streaming replies grow after insertion, so keep the source text
                // here and re-render on each update.
                let currentText = text;
                const textNode = msg.querySelector('.message-text');

                // Copy button
                const copyBtn = msg.querySelector('.btn-msg-action[aria-label="Copy"]');
                copyBtn.addEventListener('click', function() {
                    navigator.clipboard.writeText(currentText).then(function() {
                        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
                        setTimeout(function() {
                            copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
                        }, 2000);
                    });
                });

                return {
                    element: msg,
                    append: function(chunk) {
                        currentText += chunk;
                        textNode.innerHTML = formatText(currentText);
                    },
                    setText: function(next) {
                        currentText = next;
                        textNode.innerHTML = formatText(currentText);
                    }
                };
            }

            function formatText(text) {
                // Escape HTML
                let formatted = text
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');

                // Code blocks
                formatted = formatted.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

                // Inline code
                formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');

                // Bold
                formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

                // Line breaks to paragraphs
                formatted = formatted.split('\n\n').map(function(p) {
                    return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
                }).join('');

                return formatted;
            }

            function scrollToBottom() {
                requestAnimationFrame(function() {
                    chatArea.scrollTop = chatArea.scrollHeight;
                });
            }

            // Send button
            btnSend.addEventListener('click', function() {
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

            // ===== HISTORY ITEMS =====
            historyItems.forEach(function(item) {
                item.addEventListener('click', function(e) {
                    if (e.target.closest('.btn-item-action')) return;
                    historyItems.forEach(function(i) { i.classList.remove('active'); });
                    this.classList.add('active');
                    if (getBreakpoint() !== 'desktop') {
                        closeSidebar();
                    }
                });

                // Delete button
                const delBtn = item.querySelector('.btn-item-action[aria-label="Delete"]');
                if (delBtn) {
                    delBtn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        item.style.transition = 'opacity 0.2s, transform 0.2s';
                        item.style.opacity = '0';
                        item.style.transform = 'translateX(-10px)';
                        setTimeout(function() { item.remove(); }, 200);
                    });
                }
            });

            // ===== NEW CHAT =====
            btnNewChat.addEventListener('click', function() {
                if (inFlight) inFlight.abort();
                currentConversationId = null;
                chatStarted = false;
                welcomeScreen.style.display = '';
                messagesWrapper.classList.remove('visible');
                messagesWrapper.innerHTML = '';
                historyItems.forEach(function(i) { i.classList.remove('active'); });
                if (getBreakpoint() !== 'desktop') {
                    closeSidebar();
                }
                chatInput.focus();
            });

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
                        modelOptions.forEach(function(o) { o.classList.remove('active'); });
                        this.classList.add('active');
                        currentModel.textContent = this.getAttribute('data-model');
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

