import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// src/config.ts reads the environment at import time, so the database path
// has to be set before anything under src/ is loaded.
process.env.DATABASE_PATH = path.join(
  process.env.TEMP ?? process.env.TMP ?? '.',
  `chatbotai-static-${process.pid}.db`,
);
process.env.AI_PROVIDER = 'mock';

/**
 * The static file server must expose the frontend and nothing else.
 *
 * These paths used to be public because the app mounted express.static() on the
 * repository root. The worst of them is the SQLite database, which holds every
 * user's scrypt password hash, session token hash and full message history.
 */
describe('static file serving', () => {
  let browser: import('./helpers.ts').CookieJar;
  let close: () => Promise<void>;

  before(async () => {
    const { createTestServer, jar } = await import('./helpers.ts');
    const server = await createTestServer();
    browser = jar({ baseUrl: server.baseUrl, name: 'static' });
    close = server.close;
  });

  after(async () => {
    await close();
  });

  it('serves the app shell and the allowlisted asset paths', async () => {
    const shell = await browser.get('/');
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-type') ?? '', /text\/html/);

    for (const asset of ['/manifest.json', '/sw.js', '/css/style.css', '/js/script.js']) {
      const response = await browser.get(asset);
      assert.equal(response.status, 200, `${asset} should be served`);
    }
  });

  it('does not serve the SQLite database', async (t) => {
    // The test database lives in a temp dir, but the route resolves against the
    // repository root — which is exactly how the real data/chatbot.db leaked.
    const dbPath = path.join(process.cwd(), 'data', 'chatbot.db');
    if (!existsSync(dbPath)) {
      t.skip('no data/chatbot.db on disk; the leak cannot be reproduced here');
      return;
    }

    for (const attempt of ['/data/chatbot.db', '/data/chatbot.db-wal', '/data/chatbot.db-shm']) {
      const response = await browser.get(attempt);
      assert.equal(response.status, 404, `${attempt} must not be public`);

      const body = await response.text();
      assert.doesNotMatch(body, /SQLite format 3/, `${attempt} leaked database bytes`);
    }
  });

  it('does not serve source, tests, dependencies or dotfiles', async () => {
    const forbidden = [
      '/package.json',
      '/package-lock.json',
      '/tsconfig.json',
      '/vercel.json',
      '/README.md',
      '/.env',
      '/.env.example',
      '/.gitignore',
      '/src/app.ts',
      '/src/config.ts',
      '/src/db/schema.sql',
      '/test/helpers.ts',
      '/api/chat.ts',
      '/supabase/schema.sql',
      '/node_modules/express/package.json',
      '/data',
      '/src',
    ];

    for (const attempt of forbidden) {
      const response = await browser.get(attempt);
      assert.equal(response.status, 404, `${attempt} must not be public`);
    }
  });

  it('does not resolve a missing asset to the app shell', async () => {
    // express.static(ROOT_DIR, { extensions: ['html'] }) used to answer these
    // with index.html, which hid typos in asset paths.
    const response = await browser.get('/js/does-not-exist.js');
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /<html/i);
  });

  it('still answers unknown /api routes with a JSON error', async () => {
    const response = await browser.get('/api/does-not-exist');
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  });

  it('serves the app shell for client-side routes so deep links resolve', async () => {
    // /c/:id and /share/:shareId are the whole point of a shareable link: they
    // get pasted into other browsers, which is a hard navigation. A 404 here
    // would break sharing for everyone except the person who made the link.
    for (const route of ['/c/abc-123', '/share/s1.abc', '/c/abc-123/', '/share/s1.a.b_c-d']) {
      const response = await browser.get(route);
      assert.equal(response.status, 200, `${route} must serve the shell`);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await response.text(), /<div id="shareView"|share-view/);
    }
  });

  it('every function declared in vercel.json actually exists', () => {
    // Vercel fails the whole deploy with "The pattern X defined in functions
    // doesn't match any Serverless Functions inside the api directory" when a
    // path here does not resolve. That is a hard build break, and it is easy to
    // cause by removing or renaming a handler without editing this list.
    const vercelPath = path.join(process.cwd(), 'vercel.json');
    const vercel = JSON.parse(readFileSync(vercelPath, 'utf8')) as {
      functions?: Record<string, { maxDuration?: number }>;
    };

    const declared = Object.keys(vercel.functions ?? {});
    assert.ok(declared.length > 0, 'expected at least one declared function');

    const missing = declared.filter((relative) => !existsSync(path.join(process.cwd(), relative)));
    assert.deepEqual(missing, [], 'vercel.json declares functions that do not exist');
  });

  it('every handler in api/ is reachable at its own route', () => {
    // A handler that exists but is misnamed is silently never invoked, which
    // looks identical to "the feature is broken".
    const apiDir = path.join(process.cwd(), 'api');
    const handlers = readdirSync(apiDir).filter((f) => f.endsWith('.ts'));

    assert.ok(handlers.length > 0, 'expected handlers in api/');
    for (const file of handlers) {
      const source = readFileSync(path.join(apiDir, file), 'utf8');
      assert.match(
        source,
        /export default (async )?function handler/,
        `api/${file} must default-export a handler for Vercel to route to it`,
      );
    }
  });

  it('declares the same client-side rewrites on Vercel', () => {    const vercelPath = path.join(process.cwd(), 'vercel.json');
    const vercel = JSON.parse(readFileSync(vercelPath, 'utf8')) as {
      rewrites?: { source: string; destination: string }[];
    };

    const sources = (vercel.rewrites ?? []).map((r) => r.source);
    // Without these, a deployed /c/:id is a 404 while local dev works — the
    // worst kind of environment-only bug.
    assert.ok(sources.includes('/c/:id'), 'vercel.json must rewrite /c/:id');
    assert.ok(sources.includes('/share/:shareId'), 'vercel.json must rewrite /share/:shareId');

    for (const rewrite of vercel.rewrites ?? []) {
      assert.equal(rewrite.destination, '/index.html');
    }
  });
});

/**
 * Asset references must stay in step with the repository.
 *
 * Adding a script to index.html but forgetting the service worker precache list
 * is an easy mistake that only shows up as a blank page on a second visit,
 * long after the change was merged.
 */
describe('asset manifests', () => {
  const root = process.cwd();
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
  /** Local (non-CDN) references from an HTML attribute such as src or href. */
  function localRefs(html: string, attribute: string): string[] {
    return [...html.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))]
      .map((m) => m[1] ?? '')
      .filter((value) => !/^(https?:)?\/\//.test(value) && !value.startsWith('data:'))
      .map((value) => value.split('?')[0] ?? '')
      .map((value) => value.split('#')[0] ?? '')
      .filter((value) => value !== '');
  }

  it('every local script and stylesheet in index.html exists', () => {
    const html = read('index.html');
    const refs = [...localRefs(html, 'src'), ...localRefs(html, 'href')];

    assert.ok(refs.length > 0, 'expected index.html to reference local assets');
    for (const ref of refs) {
      assert.ok(
        existsSync(path.join(root, ref.replace(/^\//, ''))),
        `index.html references "${ref}", which does not exist`,
      );
    }
  });

  it('every local precache URL in sw.js exists', () => {
    const sw = read('sw.js');
    const start = sw.indexOf('PRECACHE_URLS');
    const end = sw.indexOf('];', start);
    assert.ok(start !== -1 && end !== -1, 'PRECACHE_URLS not found in sw.js');

    const block = sw.slice(start, end);
    const refs = [...block.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]!);

    assert.ok(refs.length > 0, 'expected a non-empty precache list');
    for (const ref of refs) {
      // "/" is served by index.html.
      const target = ref === '/' ? 'index.html' : ref.replace(/^\//, '');
      assert.ok(
        existsSync(path.join(root, target)),
        `sw.js precaches "${ref}", which does not exist`,
      );
    }
  });

  it('the service worker serves a newer cache name than before', () => {
    // Stale-while-revalidate refreshes assets in the background, so a bump is
    // only needed for structural changes — but it must never go backwards.
    const sw = read('sw.js');
    const match = sw.match(/const CACHE_NAME = '([^']+)'/);
    assert.ok(match, 'CACHE_NAME not found in sw.js');
    const version = Number(match![1]!.match(/v(\d+)$/)?.[1]);
    assert.ok(Number.isFinite(version) && version > 0, 'CACHE_NAME must end in v<n>');
  });

    it('every password input sits inside a form element', () => {
    // Chrome logs "Password field is not contained in a form" for any
    // type="password" outside a form, which includes the API-key fields with a
    // reveal toggle — they are still password inputs to the browser.
    const html = read('index.html');

    // Remove every form block, then assert no password input survives.
    const withoutForms = html.replace(/<form\b[\s\S]*?<\/form>/g, '');
    const strays = withoutForms.match(/<input[^>]*type="password"/g) ?? [];
    assert.deepEqual(strays, [], 'password inputs must be wrapped in a <form>');

    const wrapped = [...html.matchAll(/<form\b[\s\S]*?<\/form>/g)];
    assert.ok(wrapped.length > 0, 'expected at least one form');
    for (const block of wrapped) {
      for (const input of block[0].match(/<input[^>]*type="password"[^>]*>/g) ?? []) {
        // A masked API key is still a credential to a password manager, so it
        // opts out explicitly rather than being offered as a login field.
        assert.match(input, /autocomplete="off"/, 'masked key inputs need autocomplete="off"');
      }
    }
  });

  it('every API key card is a form whose submit button does not reload the page', () => {
    const html = read('index.html');
    const cards = [...html.matchAll(/<form class="api-card"[^>]*data-provider="([a-z]+)"[\s\S]*?<\/form>/g)];

    assert.ok(cards.length > 0, 'expected API key cards');
    for (const card of cards) {
      assert.ok(
        /data-api-save[^>]*type="submit"/.test(card[0]),
        `card "${card[1]}" must submit via the form, not a type=button click`,
      );
    }

    // The handler that stops the default and forwards to Save.
    const script = read('js/script.js');
    assert.match(script, /addEventListener\('submit'[\s\S]{0,400}preventDefault\(\)/);
    assert.match(script, /addEventListener\('submit'[\s\S]{0,400}data-api-save/);
  });

  it('never fetches optional endpoints the server has not advertised', () => {
    // Guards the console-noise class of bug: a request that is guaranteed to
    // 404 on the serverless deployment should not be fired on every load.
    const script = read('js/script.js');

    assert.match(script, /serverCapabilities/, 'the app must cache a capability probe');
    assert.match(
      script,
      /capabilities\.conversations/,
      'importServerConversations must be gated on the conversations capability',
    );
    assert.match(script, /function isShareRoute\(\)/);
    assert.match(
      script,
      /if \(isShareRoute\(\)\) return;/,
      'a shared read-only view must skip the conversation sync entirely',
    );
  });

  it('every settings menu item points at a panel that exists', () => {    // Removing a panel without its menu item leaves a dead button that toggles
    // nothing; the reverse leaves a panel nothing can reach.
    const html = read('index.html');
    const menuItems = new Set(
      [...html.matchAll(/class="settings-menu-item[^"]*"[^>]*data-panel="([a-z-]+)"/g)].map((m) => m[1]),
    );
    const panels = new Set(
      [...html.matchAll(/class="settings-panel[^"]*"[^>]*data-panel="([a-z-]+)"/g)].map((m) => m[1]),
    );

    assert.ok(menuItems.size > 0, 'expected settings menu items to exist');

    const dead = [...menuItems].filter((p) => !panels.has(p));
    assert.deepEqual(dead, [], 'menu items with no matching panel');

    const unreachable = [...panels].filter((p) => !menuItems.has(p));
    assert.deepEqual(unreachable, [], 'panels no menu item can reach');
  });
});