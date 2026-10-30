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

const CACHE_NAME = 'chatbotai-static-v9';
const OFFLINE_URL = '/index.html';

// Everything is served from this origin (see vendor/). Nothing here needs a
// cross-origin request, so the service worker never has to cache opaque
// responses and the CSP can stay at script-src 'self'.
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/fonts.css',
  '/css/style.css',
  '/js/markdown-math.js',
  '/js/pdfjs-init.js',
  '/js/settings.js',
  '/js/voice.js',
  '/js/share.js',
  '/js/share-view.js',
  '/js/lightbox.js',
  '/js/title.js',
  '/js/ui.js',
  '/js/script.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/vendor/dompurify/3.4.17/purify.min.js',
  '/vendor/pdfjs/6.4.299/pdf.min.mjs',
  '/vendor/pdfjs/6.4.299/pdf.worker.min.mjs',
  '/vendor/supabase/2.117.3/supabase.min.js',
  '/vendor/font-awesome/6.5.1/css/all.min.css',
  '/vendor/font-awesome/6.5.1/webfonts/fa-solid-900.woff2',
  '/vendor/font-awesome/6.5.1/webfonts/fa-regular-400.woff2',
  '/vendor/font-awesome/6.5.1/webfonts/fa-brands-400.woff2',
  '/vendor/font-awesome/6.5.1/webfonts/fa-v4compatibility.woff2',
  '/vendor/inter/inter-400-latin.woff2',
  '/vendor/inter/inter-400-latin-ext.woff2',
  '/vendor/inter/inter-500-latin.woff2',
  '/vendor/inter/inter-500-latin-ext.woff2',
  '/vendor/inter/inter-600-latin.woff2',
  '/vendor/inter/inter-600-latin-ext.woff2',
  '/vendor/inter/inter-700-latin.woff2',
  '/vendor/inter/inter-700-latin-ext.woff2',
  // KaTeX's font files are deliberately NOT precached. The stylesheet and
  // script are enough for formulas to render offline; only the typeface falls
  // back until the next online load.
  '/vendor/katex/0.16.11/katex.min.css',
  '/vendor/katex/0.16.11/katex.min.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE_NAME);
    // Cache each asset on its own so a single failure cannot abort the install.
    await Promise.all(PRECACHE_URLS.map(async function (url) {
      try {
        const target = new URL(url, self.location.origin);
        const request = new Request(target.href, { cache: 'reload' });
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

  // The auth page is compiled in the browser by Babel Standalone
  // (type="text/babel"), so a stale cached copy means the user runs old JS and
  // silently gets bugs that were already fixed. It is small and rarely
  // visited, so it is fetched network-first.
  if (isSameOrigin && url.pathname.indexOf('/components/auth/') === 0) return;

  // Third-party API traffic (Supabase, translation) is never cached. Every
  // static asset is same-origin, so there is no CDN allowlist to maintain.
  if (!isSameOrigin) return;

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
