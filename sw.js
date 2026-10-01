/* ChatBot AI — Service Worker
   Cache-First strategy for the app shell and static assets, so the app can
   boot and render offline. API traffic is never cached.
   Bump CACHE_NAME to invalidate old caches on the next deploy. */
'use strict';

const CACHE_NAME = 'chatbotai-static-v1';
const OFFLINE_URL = '/index.html';
const CDN_DOMPURIFY = 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/script.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  CDN_DOMPURIFY
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

  const isCdnAsset = url.href === CDN_DOMPURIFY || url.hostname === 'cdnjs.cloudflare.com';
  if (!isSameOrigin && !isCdnAsset) return;

  event.respondWith((async function () {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
      const response = await fetch(request);
      if (response && (response.ok || response.type === 'opaque')) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
      }
      return response;
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
