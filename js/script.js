        (function() {
            'use strict';

            // Elements
            const sidebar = document.getElementById('sidebar');
            const overlay = document.getElementById('sidebarOverlay');
            const btnOpen = document.getElementById('btnOpenSidebar');
            const btnClose = document.getElementById('btnCloseSidebar');
            const btnNewChat = document.getElementById('btnNewChat');
            const chatInput = document.getElementById('chatInput');
            const btnSend = document.getElementById('btnSend');
            const chatArea = document.getElementById('chatArea');
            const messagesWrapper = document.getElementById('messagesWrapper');
            const welcomeScreen = document.getElementById('welcomeScreen');
            const typingIndicator = document.getElementById('typingIndicator');
            const historyItems = document.querySelectorAll('.history-item');
            const quickActions = document.querySelectorAll('.quick-action');
            const searchInput = document.getElementById('searchInput');
            const btnClearSearch = document.getElementById('btnClearSearch');
            const btnThemeToggle = document.getElementById('btnThemeToggle');
            const btnModelDropdown = document.getElementById('btnModelDropdown');
            const modelDropdown = document.getElementById('modelDropdown');
            const modelOptions = document.querySelectorAll('.model-option');
            const currentModel = document.getElementById('currentModel');
            const chatHistory = document.getElementById('chatHistory');


            
            // State
            let chatStarted = false;

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
            btnClose.addEventListener('click', closeSidebar);
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
                const hasText = chatInput.value.trim() !== '';
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
                if (!text || text.trim() === '') return;

                if (!chatStarted) {
                    chatStarted = true;
                    welcomeScreen.style.display = 'none';
                    messagesWrapper.classList.add('visible');
                }

                // Add user message
                addMessage('user', text.trim());

                // Clear input
                chatInput.value = '';
                chatInput.style.height = 'auto';
                updateSendState();

                // Show typing
                typingIndicator.classList.add('visible');
                scrollToBottom();

                // Simulate response
                setTimeout(function() {
                    typingIndicator.classList.remove('visible');
                    const responses = [
                        "That's a great question! Here's what I think:\n\nThe solution involves breaking down the problem into smaller, manageable parts. Each part can then be addressed individually, which makes the overall solution much cleaner and easier to implement.",
                        "I'd be happy to help with that!\n\nHere's a step-by-step approach:\n\n1. First, understand the core requirements\n2. Plan your architecture\n3. Implement incrementally\n4. Test each component thoroughly\n\nWould you like me to go into more detail on any of these steps?",
                        "Great point! Let me explain that in detail.\n\nThe key concept here is to maintain clean separation of concerns. This means each module should have a single responsibility and communicate with others through well-defined interfaces.",
                        "Here's my take on this:\n\n```javascript\nfunction example() {\n    return 'Clean, well-structured code';\n}\n```\n\nThe main thing to remember is to keep your code simple and readable. Always write code for humans first, machines second.",
                        "Absolutely! Here's what you need to know:\n\nThe most important aspect is consistency. Whether you're working on frontend or backend, following a consistent pattern will make your codebase much more maintainable in the long run."
                    ];
                    const response = responses[Math.floor(Math.random() * responses.length)];
                    addMessage('assistant', response);
                    scrollToBottom();
                }, 1200 + Math.random() * 800);
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

                // Copy button
                const copyBtn = msg.querySelector('.btn-msg-action[aria-label="Copy"]');
                copyBtn.addEventListener('click', function() {
                    navigator.clipboard.writeText(text).then(function() {
                        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
                        setTimeout(function() {
                            copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
                        }, 2000);
                    });
                });
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

            // ===== SEARCH CONVERSATIONS =====
            function filterHistory(query) {
                query = query.trim().toLowerCase();
                const sections = document.querySelectorAll('.history-section');
                let anyMatch = false;

                sections.forEach(function(section) {
                    let sectionMatch = false;
                    const items = section.querySelectorAll('.history-item');
                    items.forEach(function(item) {
                        const text = item.querySelector('.history-item-text').textContent.toLowerCase();
                        const match = !query || text.indexOf(query) !== -1;
                        item.classList.toggle('hidden', !match);
                        if (match) sectionMatch = true;
                    });
                    section.classList.toggle('has-matches', sectionMatch);
                    if (sectionMatch) anyMatch = true;
                });

                chatHistory.classList.toggle('searching', !!query);
                btnClearSearch.hidden = !query;
                const noResults = document.querySelector('.no-results');
                if (noResults) {
                    noResults.classList.toggle('visible', !!query && !anyMatch);
                }
            }

            if (searchInput) {
                searchInput.addEventListener('input', function() {
                    filterHistory(this.value);
                });
                searchInput.addEventListener('keydown', function(e) {
                    if (e.key === 'Escape') {
                        this.value = '';
                        filterHistory('');
                        this.blur();
                    }
                });
            }

            if (btnClearSearch) {
                btnClearSearch.addEventListener('click', function() {
                    if (searchInput) {
                        searchInput.value = '';
                        filterHistory('');
                        searchInput.focus();
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

            if (btnThemeToggle) {
                btnThemeToggle.addEventListener('click', function() {
                    const isLight = document.body.classList.contains('light');
                    applyTheme(isLight ? 'dark' : 'light');
                });
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

            function openPlusDropdown() {
                plusDropdown.hidden = false;
                btnPlus.classList.add('open');
            }

            function plusDropdownIsOpen() {
                return plusDropdown && !plusDropdown.hidden;
            }

            function closePlusDropdown() {
                if (plusDropdown) {
                    plusDropdown.hidden = true;
                    btnPlus.classList.remove('open');
                }
            }

            if (btnPlus && plusDropdown) {
                btnPlus.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const isOpen = !plusDropdown.hidden;
                    closeModelDropdown();
                    closePlusDropdown();
                    if (!isOpen) {
                        plusDropdown.hidden = false;
                        btnPlus.classList.add('open');
                    }
                });

                plusDropdown.addEventListener('click', function(e) {
                    e.stopPropagation();
                    closePlusDropdown();
                });
            }

            document.addEventListener('click', function() {
                if (modelDropdown && !modelDropdown.hidden) closeModelDropdown();
                if (plusDropdownIsOpen()) closePlusDropdown();
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

            // Sidebar Menu Navigation & Title Update
            settingsMenuItems.forEach(item => {
                item.addEventListener('click', () => {
                    settingsMenuItems.forEach(el => el.classList.remove('active'));
                    item.classList.add('active');
                    if (settingsPageTitle) {
                        settingsPageTitle.textContent = item.getAttribute('data-title');
                    }
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