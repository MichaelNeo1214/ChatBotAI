/* ChatBot AI — Service Worker
   Stale-while-revalidate for the app shell and static assets, so the app boots
   offline and a returning visitor still picks up a new deploy on the next load.
   API traffic is never cached.

   The previous strategy was cache-first, which meant a returning visitor kept
   running the previously cached js/script.js until CACHE_NAME changed — fixes
   silently did not reach the browser. Now a cached asset is served immediately
   and refreshed in the background for the next load.

   The name is bumped whenever a module changes its wire format (such as the
   share-link encoder moving to Base64URL). A stale js/share.js cannot decode a
   token written by a new one, and the visitor sees "This link could not be
   opened" with nothing to act on. */
'use strict';

const CACHE_NAME = 'chatbotai-static-v5';
const OFFLINE_URL = '/index.html';
const CDN_DOMPURIFY = 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js';
const CDN_PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const CDN_PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const CDN_KATEX_JS = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
const CDN_KATEX_CSS = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/markdown-math.js',
  '/js/settings.js',
  '/js/share.js',
  '/js/share-view.js',
  '/js/ui.js',
  '/js/script.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  CDN_DOMPURIFY,
  CDN_PDFJS,
  CDN_PDFJS_WORKER,
  // KaTeX's ~60 font files are deliberately NOT precached. The stylesheet and
  // script are enough for formulas to render offline; only the typeface falls
  // back until the next online load.
  CDN_KATEX_CSS,
  CDN_KATEX_JS
];

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE_NAME);
    // Cache each asset on its own so a single failure cannot abort the install.
    await Promise.all(PRECACHE_URLS.map(async function (url) {
      try {
        const target = new URL(url, self.location.origin);
        const request = new Request(target.href, {
          mode: target.origin === self.location.origin ? 'same-origin' : 'no-cors',
          cache: 'reload'
        });
        const response = await fetch(request);
        if (response) await cache.put(url, response);
      } catch (e) { /* ignore individual asset failures */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.map(function (key) {
      if (key !== CACHE_NAME) return caches.delete(key);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  // API traffic must always reach the network.
  if (isSameOrigin && url.pathname.indexOf('/api/') === 0) return;

  const isCdnAsset = url.href === CDN_DOMPURIFY
    || url.hostname === 'cdnjs.cloudflare.com'
    || url.hostname === 'cdn.jsdelivr.net';
  if (!isSameOrigin && !isCdnAsset) return;

  event.respondWith((async function () {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);

    // Exactly one network request either way: it refreshes the cache and its
    // response is returned only when there was nothing cached to serve.
    const fromNetwork = fetch(request).then(function (response) {
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(request, response.clone());
      }
      return response;
    });

    if (cached) {
      // Serve immediately; refresh for next load. A failed refresh while
      // offline must not surface as an error, so it is swallowed.
      event.waitUntil(fromNetwork.catch(function () {}));
      return cached;
    }

    try {
      return await fromNetwork;
    } catch (e) {
      // Offline navigation falls back to the cached app shell.
      if (request.mode === 'navigate') {
        const shell = (await caches.match(OFFLINE_URL)) || (await caches.match('/'));
        if (shell) return shell;
      }
      return new Response('Offline', { status: 504, statusText: 'Offline' });
    }
  })());
});
