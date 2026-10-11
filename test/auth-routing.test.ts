import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * Routing the way Vercel resolves it.
 *
 * Vercel picks a function by FILE PATH, then hands the handler a request whose
 * `url` is that path. So `/api/auth/me` is served by `api/auth/me.ts` — never
 * by a single catch-all that parses `req.url`.
 *
 * These tests import each subpath module the way the runtime would and assert
 * the action resolves. A handler that is unreachable but syntactically perfect
 * still produces a 404, and that is exactly the failure this file exists to
 * prevent.
 */
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function fakeRes() {
  const captured = { status: 0, headers: {} as Record<string, string>, body: '' };
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

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  return Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
    method,
    url,
    headers: {},
  }) as unknown as IncomingMessage;
}

/** Configured so the capability gate passes and routing is what is under test. */
describe('api/auth — Vercel file routing', () => {
  const saved = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_ANON_KEY,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('SUPABASE_URL', saved.url);
    restore('SUPABASE_ANON_KEY', saved.key);
    restore('SUPABASE_SERVICE_ROLE_KEY', saved.service);
  });

  /** Each entry: [url, module, method, body] */
  const cases: [string, string, string, unknown?][] = [
    ['/api/auth/me', '../api/auth/me.ts', 'GET'],
    ['/api/auth/login', '../api/auth/login.ts', 'POST', { email: 'bad', password: '' }],
    ['/api/auth/signup', '../api/auth/signup.ts', 'POST', { email: 'bad', password: 'short' }],
    ['/api/auth/logout', '../api/auth/logout.ts', 'POST'],
    ['/api/auth/logout-all', '../api/auth/logout-all.ts', 'POST'],
    ['/api/auth/account', '../api/auth/account.ts', 'DELETE', { confirm: false }],
  ];

  for (const [url, modulePath, method, body] of cases) {
    it(`routes ${method} ${url} to its handler`, async () => {
      const { default: handler } = (await import(modulePath)) as { default: Handler };
      assert.equal(typeof handler, 'function', `${modulePath} must default-export a handler`);

      const { res, captured } = fakeRes();
      await handler(fakeReq(method, url, body), res);

      // A 404-equivalent here would be 405 (unrouted) or 503 (capability gate).
      // Neither means the path did not resolve.
      assert.notEqual(captured.status, 405, `${url} resolved as an unknown route`);
      assert.notEqual(captured.status, 503, `${url} hit the capability gate`);
      assert.notEqual(captured.status, 404);
    });
  }

  it('distinguishes logout from logout-all rather than collapsing both', async () => {
    // If the router matched on the first segment only, logout-all would be
    // treated as logout and "sign out everywhere" would silently under-deliver.
    const { default: logout } = (await import('../api/auth/logout.ts')) as { default: Handler };
    const { default: logoutAll } = (await import('../api/auth/logout-all.ts')) as { default: Handler };
    assert.notEqual(logout, undefined);
    assert.notEqual(logoutAll, undefined);

    const { res: r1, captured: c1 } = fakeRes();
    await logout(fakeReq('POST', '/api/auth/logout'), r1);
    assert.equal(c1.status, 204);

    const { res: r2, captured: c2 } = fakeRes();
    await logoutAll(fakeReq('POST', '/api/auth/logout-all'), r2);
    assert.equal(c2.status, 204);
  });

  it('serves the bare /api/auth route as well', async () => {
    const { default: handler } = (await import('../api/auth/index.ts')) as { default: Handler };
    const { res, captured } = fakeRes();
    await handler(fakeReq('GET', '/api/auth'), res);

    assert.equal(captured.status, 200);
    const body = JSON.parse(captured.body) as { user: null };
    assert.equal(body.user, null);
  });

  it('every subpath handler reaches the shared implementation', async () => {
    // If one of these diverged into its own copy, a fix to the shared logic
    // would silently skip that route.
    const shared = (await import('../api/auth/index.ts')) as { default: Handler };
    for (const modulePath of [
      '../api/auth/me.ts',
      '../api/auth/login.ts',
      '../api/auth/signup.ts',
      '../api/auth/logout.ts',
      '../api/auth/logout-all.ts',
      '../api/auth/account.ts',
    ]) {
      const mod = (await import(modulePath)) as { default: Handler };
      assert.equal(mod.default, shared.default, `${modulePath} must delegate to ./index.ts`);
    }
  });
});
