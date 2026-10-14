import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

describe('api/auth - Supabase not configured', () => {
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

describe('api/auth - routing and guards', () => {
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

/**
 * Upstream failure handling.
 *
 * The reported symptom was a 502 on signup while Supabase showed the user was
 * created. A 502 means the invocation never produced a response, which happens
 * when the platform kills a function that outlives maxDuration - not when code
 * throws. So the contract these tests pin down is: whatever Supabase does, this
 * handler answers, and it answers with a status that names the real cause.
 */
describe('api/auth - upstream failures answer cleanly', () => {
  const saved = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_ANON_KEY,
  };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = saved.key;
  });

  it('survives a malformed cookie value instead of throwing', async () => {
    globalThis.fetch = (async () =>
      new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const handler = await load();
    // A stray '%' is not a valid escape and decodeURIComponent throws on it.
    const { res, captured } = fakeRes();
    await handler(fakeReq('GET', '/api/auth/me', undefined, 'cbai_session=100%off; other=%zz'), res);

    assert.equal(captured.status, 200, 'a malformed cookie must degrade to anonymous, not crash');
  });
});

/**
 * Configuration guarantees that keep the invocation from being killed.
 *
 * These are asserted against the source rather than by driving Supabase: the
 * SDK validates its own response shapes, so a stubbed fetch cannot stand in for
 * a real session, and a test that pretends otherwise would pass without proving
 * anything. What must not regress is that the client is configured safely for a
 * runtime with no storage and no clock.
 */
describe('api/auth - client configuration', () => {
  const source = () => readFileSync(path.join(process.cwd(), 'api', 'auth', 'index.ts'), 'utf8');

  it('declares @supabase/supabase-js as a runtime dependency', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    assert.ok(
      pkg.dependencies?.['@supabase/supabase-js'],
      'the SDK must be a runtime dependency or the Vercel build fails on an unresolved import',
    );
  });

  it('disables session persistence, which a serverless runtime cannot provide', () => {
    // A client that tries to persist a session has nowhere to write it and no
    // refresh cycle to run; auto-refresh leaves a timer that outlives the
    // invocation and the platform kills the function.
    const code = source();
    assert.match(code, /persistSession: false/);
    assert.match(code, /autoRefreshToken: false/);
    assert.match(code, /detectSessionInUrl: false/);
  });

  it('bounds every Supabase call so it cannot outlive maxDuration', () => {
    // An invocation killed by the platform is reported as a 502 with no stack
    // trace, which is the failure being chased.
    const code = source();
    assert.match(code, /const UPSTREAM_TIMEOUT_MS = \d+_000;/);
    assert.match(code, /AbortSignal\.timeout\(UPSTREAM_TIMEOUT_MS\)/);
  });

  it('reads credentials from the environment, never from a file', () => {
    // Comments are stripped first: the file documents *why* there is no local
    // database, so a raw text match would flag its own explanation.
    const code = source().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // Every env read is delegated to the validating helper. The handler must not
    // read process.env.SUPABASE_URL itself: createClient() throws "Invalid
    // supabaseUrl" on an unparsed value, so the URL has to pass through
    // getValidSupabaseUrl() first.
    assert.match(code, /from '\.\.\/\.\.\/src\/supabase-url\.ts'/);
    assert.match(code, /getValidSupabaseUrl\(\)/);
    assert.match(code, /getSanitizedSupabaseKey\(\)/);
    assert.doesNotMatch(code, /process\.env\.SUPABASE_URL/);
    assert.doesNotMatch(code, /readFileSync|writeFileSync|node:fs/);
  });

  it('does not import or reference the local database layer', () => {
    const code = source().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /sqlite|DatabaseSync|src\/db/);
    // It does not even reach the module that would open one.
    assert.match(code, /import \{ createClient, type SupabaseClient \} from '@supabase\/supabase-js';/);
  });
});
describe('api/auth - always responds', () => {
  const saved = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_ANON_KEY,
  };

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
  });

  afterEach(() => {
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = saved.key;
  });

  /**
   * A request whose body stream has already been fully consumed.
   *
   * A plain object rather than a real Readable: `readableEnded` is getter-only
   * on a stream, and the point here is to model "the runtime already parsed the
   * body", where no further 'end' event will ever be emitted.
   */
  function alreadyEndedReq(method: string, url: string): IncomingMessage {
    return {
      method,
      url,
      headers: {},
      body: undefined,
      readableEnded: true,
      destroyed: true,
      on: () => {},
    } as unknown as IncomingMessage;
  }

  it('answers instead of hanging when the body stream has already ended', async () => {
    const handler = await load();
    const { res, captured } = fakeRes();

    const pending = handler(alreadyEndedReq('POST', '/api/auth/login'), res);
    const guard = Symbol('handler never responded');

    const outcome = await Promise.race([
      pending.then(() => 'responded' as const),
      new Promise<typeof guard>((resolve) => setTimeout(() => resolve(guard), 2000)),
    ]);

    assert.notEqual(outcome, guard, 'the handler must settle, not hang');
    // With no body it cannot validate an email, so it answers 400 - not a hang.
    assert.equal(captured.status, 400);
    assert.match(captured.body, /invalid_email/);
  });

  it('answers an oversized body rather than destroying the request stream', async () => {
    const handler = await load();
    const { res, captured } = fakeRes();

    let destroyed = false;
    let emitted = 0;
    const huge = 'x'.repeat(64 * 1024);

    const stream = {
      method: 'POST',
      url: '/api/auth/signup',
      headers: {},
      body: undefined,
      readableEnded: false,
      destroyed: false,
      on(event: string, fn: (chunk?: Buffer) => void) {
        if (event === 'data') {
          emitted++;
          fn(Buffer.from(huge, 'utf8'));
        }
        return this;
      },
      destroy() {
        destroyed = true;
      },
    } as unknown as IncomingMessage;

    await handler(stream, res);

    // Destroying the socket mid-request can prevent the response from being
    // written at all, which the platform reports as a 502.
    assert.equal(destroyed, false, 'the request stream must not be destroyed');
    assert.ok(emitted > 0, 'the fixture must actually deliver a body');
    assert.notEqual(captured.status, 0, 'a response must have been written');
  });
});
