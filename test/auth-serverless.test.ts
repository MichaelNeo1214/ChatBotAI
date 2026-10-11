import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * The serverless auth function.
 *
 * Two things matter most here and are both easy to get wrong:
 *
 *  1. With no Supabase configured it must answer 503 with a named code, NOT
 *     404. A 404 is indistinguishable from a deployment mistake and produces
 *     console noise on every page load; a named 503 lets the frontend detect
 *     the capability once and stop asking.
 *
 *  2. Validation must happen before any call to Supabase, so a malformed
 *     request never becomes an upstream round trip.
 */
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: '' };
  let statusCode = 0;
  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(v: number) {
      statusCode = v;
      captured.status = v;
    },
    headersSent: false,
    setHeader(k: string, v: string) {
      captured.headers[k.toLowerCase()] = v;
    },
    getHeader(k: string) {
      return captured.headers[k.toLowerCase()];
    },
    write(c: string) {
      captured.body += c;
      return true;
    },
    end(c?: string) {
      if (c !== undefined) captured.body += c;
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

function fakeReq(method: string, url: string, body?: unknown, cookie?: string): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  return Object.assign(stream, {
    method,
    url,
    headers: cookie ? { cookie } : {},
  }) as unknown as IncomingMessage;
}

async function load(): Promise<Handler> {
  const { default: handler } = await import('../api/auth/index.ts');
  return handler as unknown as Handler;
}

describe('api/auth — Supabase not configured', () => {
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY };

  beforeEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    if (saved.url !== undefined) process.env.SUPABASE_URL = saved.url;
    if (saved.key !== undefined) process.env.SUPABASE_ANON_KEY = saved.key;
  });

  it('answers 503 with a named code, never 404', async () => {
    const handler = await load();

    // /api/auth/me used to 404 here, which is what flooded the browser console.
    for (const [method, url] of [
      ['GET', '/api/auth/me'],
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/signup'],
      ['POST', '/api/auth/logout'],
    ] as const) {
      const { res, captured } = fakeRes();
      await handler(fakeReq(method, url, { email: 'a@b.co', password: 'password123' }), res);

      assert.equal(captured.status, 503, `${method} ${url} should be 503, not ${captured.status}`);
      const body = JSON.parse(captured.body) as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'auth_unavailable');
      // The message has to tell an operator what to do, not just that it failed.
      assert.match(body.error.message, /SUPABASE_URL/);
      assert.match(body.error.message, /SUPABASE_ANON_KEY/);
    }
  });

  it('does not leak a stack trace or internal detail', async () => {
    const handler = await load();
    const { res, captured } = fakeRes();
    await handler(fakeReq('GET', '/api/auth/me'), res);

    assert.doesNotMatch(captured.body, /at \w+ \(/);
    assert.doesNotMatch(captured.body, /\/api\/auth/);
  });
});

describe('api/auth — routing and guards', () => {
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY };

  beforeEach(() => {
    // Configured, so the handler gets past the capability gate and exercises
    // routing rather than short-circuiting on 503.
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = saved.key;
  });

  it('answers OPTIONS with 204 and an Allow header', async () => {
    const handler = await load();
    const { res, captured } = fakeRes();
    await handler(fakeReq('OPTIONS', '/api/auth/login'), res);

    assert.equal(captured.status, 204);
    assert.match(captured.headers.allow ?? '', /POST/);
  });

  it('rejects an unknown route with 405 rather than a stack trace', async () => {
    const handler = await load();
    const { res, captured } = fakeRes();
    await handler(fakeReq('POST', '/api/auth/nonsense'), res);

    assert.equal(captured.status, 405);
    const body = JSON.parse(captured.body) as { error: { code: string } };
    assert.equal(body.error.code, 'method_not_allowed');
  });

  it('ignores a query string and a trailing slash when routing', async () => {
    const handler = await load();

    // /me is a GET that never touches Supabase without a token, so it is safe
    // to assert the route resolved rather than erroring on method.
    for (const url of ['/api/auth/me', '/api/auth/me/', '/api/auth/me?x=1']) {
      const { res, captured } = fakeRes();
      await handler(fakeReq('GET', url, undefined, 'cbai_session=token'), res);
      assert.notEqual(captured.status, 405, `${url} should resolve to the me route`);
      assert.notEqual(captured.status, 503, `${url} should not hit the capability gate`);
    }
  });

  it('validates the email before calling Supabase', async () => {
    const handler = await load();
    const { res, captured } = fakeRes();
    await handler(fakeReq('POST', '/api/auth/login', { email: 'not-an-email', password: 'x' }), res);

    assert.equal(captured.status, 400);
    const body = JSON.parse(captured.body) as { error: { code: string } };
    assert.equal(body.error.code, 'invalid_email');
  });

  it('rejects a short password on signup', async () => {
    const handler = await load();
    const { res, captured } = fakeRes();
    await handler(
      fakeReq('POST', '/api/auth/signup', { email: 'a@b.co', password: 'short', name: 'A' }),
      res,
    );

    assert.equal(captured.status, 400);
    const body = JSON.parse(captured.body) as { error: { code: string } };
    assert.equal(body.error.code, 'weak_password');
  });

  it('requires a confirmation flag before deleting an account', async () => {
    const handler = await load();
    const { res, captured } = fakeRes();
    await handler(fakeReq('DELETE', '/api/auth/account', { confirm: false }), res);

    assert.equal(captured.status, 400);
    const body = JSON.parse(captured.body) as { error: { code: string } };
    assert.equal(body.error.code, 'confirmation_required');
  });

  it('reports anonymous for a request with no session cookie', async () => {
    const handler = await load();
    const { res, captured } = fakeRes();
    await handler(fakeReq('GET', '/api/auth/me'), res);

    assert.equal(captured.status, 200);
    const body = JSON.parse(captured.body) as { user: null };
    assert.equal(body.user, null, 'no cookie must be a normal anonymous visit, not an error');
  });
});
