(function () {
  "use strict";

  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('overlay');
  const menuToggle = document.getElementById('menuToggle');
  const newChatBtn = document.getElementById('newChatBtn');
  const chatScroll = document.getElementById('chatScroll');
  const chatInner = document.getElementById('chatInner');
  const emptyState = document.getElementById('emptyState');
  const input = document.getElementById('composerInput');
  const sendBtn = document.getElementById('sendBtn');
  const suggestionCards = document.querySelectorAll('.suggestion-card');

  let isGenerating = false;

  /* ---- sidebar mobile toggle ---- */
  function openSidebar() {
    sidebar.classList.add('open');
    overlay.classList.add('show');
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('show');
  }
  menuToggle.addEventListener('click', openSidebar);
  overlay.addEventListener('click', closeSidebar);

  /* close drawer automatically if resized to desktop */
  window.addEventListener('resize', function () {
    if (window.innerWidth > 768) closeSidebar();
  });

  /* ---- new chat ---- */
  newChatBtn.addEventListener('click', function () {
    document.querySelectorAll('.msg-row').forEach(el => el.remove());
    emptyState.style.display = 'flex';
    input.value = '';
    autoResize();
    updateSendState();
    closeSidebar();
  });

  /* ---- history item selection ---- */
  document.getElementById('history').addEventListener('click', function (e) {
    const item = e.target.closest('.history-item');
    if (!item) return;
    document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
    item.classList.add('active');
    closeSidebar();
  });

  /* ---- suggestion cards ---- */
  suggestionCards.forEach(card => {
    card.addEventListener('click', function () {
      input.value = card.dataset.fill || card.textContent.trim();
      autoResize();
      updateSendState();
      input.focus();
    });
  });

  /* ---- textarea auto-resize ---- */
  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }
  function updateSendState() {
    sendBtn.disabled = input.value.trim().length === 0 || isGenerating;
  }
  input.addEventListener('input', function () {
    autoResize();
    updateSendState();
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      trySend();
    }
  });
  sendBtn.addEventListener('click', trySend);

  /* ---- rendering helpers ---- */
  function scrollToBottom() {
    chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function addUserMessage(text) {
    emptyState.style.display = 'none';
    const row = document.createElement('div');
    row.className = 'msg-row user';
    row.innerHTML = '<div class="msg-content"><p>' + escapeHtml(text) + '</p></div>';
    chatInner.appendChild(row);
    scrollToBottom();
  }

  function addAssistantPlaceholder() {
    const row = document.createElement('div');
    row.className = 'msg-row assistant';
    row.innerHTML =
      '<div class="msg-avatar">M</div>' +
      '<div class="msg-content"><div class="typing"><span></span><span></span><span></span></div></div>';
    chatInner.appendChild(row);
    scrollToBottom();
    return row.querySelector('.msg-content');
  }

  /* ---- fake streaming reply (replace with real API call, see note below) ---- */
  function fakeReply(userText) {
    return "Ini contoh balasan MAX untuk: \u201c" + userText + "\u201d. " +
      "Ganti fungsi sendToBackend() di bawah dengan pemanggilan endpoint chat kamu " +
      "(disarankan pakai Server-Sent Events untuk efek mengetik seperti ini).";
  }

  function streamText(el, fullText) {
    el.innerHTML = '<p></p>';
    const p = el.querySelector('p');
    let i = 0;
    isGenerating = true;
    updateSendState();
    const interval = setInterval(function () {
      p.textContent += fullText[i];
      i++;
      scrollToBottom();
      if (i >= fullText.length) {
        clearInterval(interval);
        isGenerating = false;
        updateSendState();
      }
    }, 14);
  }

  /* ---- placeholder network call ----
     Ganti isi fungsi ini dengan fetch ke backend Node.js kamu, contoh:

     async function sendToBackend(message) {
       const res = await fetch('/api/chat', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         credentials: 'include', // supaya cookie sesi/JWT ikut terkirim
         body: JSON.stringify({ message })
       });
       // lalu baca stream (SSE) dan panggil streamText() per chunk yang datang
     }
  ------------------------------------ */
  function sendToBackend(message, targetEl) {
    setTimeout(function () {
      streamText(targetEl, fakeReply(message));
    }, 500);
  }

  function trySend() {
    const text = input.value.trim();
    if (!text || isGenerating) return;
    addUserMessage(text);
    input.value = '';
    autoResize();
    updateSendState();
    const target = addAssistantPlaceholder();
    sendToBackend(text, target);
  }

})();