import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

process.env.DATABASE_PATH = `${process.env.TEMP ?? process.env.TMP ?? '.'}/chatbotai-cors-${process.pid}.db`;
process.env.AI_PROVIDER = 'mock';

/**
 * CORS.
 *
 * The allowlisted origins come from CORS_ORIGINS, which defaults to the two
 * localhost entries and is read at import time. The preflight below therefore
 * sends those literal origins rather than the test server's own URL.
 */
const ALLOWED_ORIGIN = 'http://localhost:3000';
const BYOK_HEADERS = ['X-Provider-Key', 'X-Provider-Base-Url', 'X-Provider-Model'];

const { createTestServer, jar } = await (async () => {
  return import('./helpers.ts');
})();

describe('CORS', () => {
  let close: () => Promise<void>;
  let browser: import('./helpers.ts').CookieJar;

  before(async () => {
    const server = await createTestServer();
    browser = jar({ baseUrl: server.baseUrl, name: 'cors' });
    close = server.close;
  });

  after(async () => {
    await close();
  });

  it('allows the bring-your-own-key headers on a preflight from an allowlisted origin', async () => {
    // These three headers carry the caller's provider key. Without them in
    // Access-Control-Allow-Headers, a whitelisted cross-origin client is
    // silently unable to use any BYOK model.
    const res = await browser.request('/api/health', {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, x-provider-key',
      },
    });

    assert.equal(res.status, 204);

    const allowed = res.headers.get('access-control-allow-headers') ?? '';
    for (const header of ['Content-Type', ...BYOK_HEADERS]) {
      assert.ok(
        allowed.toLowerCase().includes(header.toLowerCase()),
        `preflight must allow ${header}; got "${allowed}"`,
      );
    }
  });

  it('echoes the origin and allows credentials for an allowlisted origin', async () => {
    const res = await browser.get('/api/health', { headers: { Origin: ALLOWED_ORIGIN } });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.match(res.headers.get('vary') ?? '', /Origin/);
  });

  it('grants nothing to an origin that is not allowlisted', async () => {
    const res = await browser.request('/api/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
      },
    });

    // The preflight still completes, but with no CORS headers the browser
    // blocks the real request.
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
    assert.equal(res.headers.get('access-control-allow-headers'), null);
  });
});

describe('TRUST_PROXY parsing', () => {
  it('defaults to off so a forged X-Forwarded-For cannot dodge rate limits', async () => {
    const { parseTrustProxy } = await import('../src/config.ts');
    assert.equal(parseTrustProxy(''), false);
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('off'), false);
    assert.equal(parseTrustProxy('no'), false);
  });

  it('accepts booleans, hop counts and proxy lists', async () => {
    const { parseTrustProxy } = await import('../src/config.ts');
    assert.equal(parseTrustProxy('true'), true);
    assert.equal(parseTrustProxy('yes'), true);
    assert.equal(parseTrustProxy('1'), 1);
    assert.equal(parseTrustProxy('3'), 3);
    // Anything else is handed to Express verbatim as a subnet/loopback list.
    assert.equal(parseTrustProxy('loopback'), 'loopback');
    assert.equal(parseTrustProxy('10.0.0.0/8'), '10.0.0.0/8');
  });

  it('is case-insensitive about the off switch', async () => {
    const { parseTrustProxy } = await import('../src/config.ts');
    assert.equal(parseTrustProxy('FALSE'), false);
    assert.equal(parseTrustProxy(' Off '), false);
  });
});