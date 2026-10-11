import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

/**
 * The Vercel serverless handlers.
 *
 * These run on a deployment where there is no Express app and no SQLite, so
 * they are exercised here as plain functions over mock req/res objects rather
 * than over a socket. That is the only way to catch a handler that only works
 * when mounted behind Express.
 */
process.env.DATABASE_PATH = `${process.env.TEMP ?? process.env.TMP ?? '.'}/chatbotai-vercel-${process.pid}.db`;
process.env.AI_PROVIDER = 'mock';

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * A minimal ServerResponse stand-in that records what the handler wrote.
 *
 * statusCode is exposed through a setter so `captured.status` always reflects
 * the last status the handler assigned, without every call site having to copy
 * it across by hand.
 */
function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: '' };
  let statusCode = 0;
  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
      captured.status = value;
    },
    headersSent: false,
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return captured.headers[name.toLowerCase()];
    },
    write(chunk: string) {
      res.headersSent = true;
      captured.body += chunk;
      return true;
    },
    end(chunk?: string) {
      res.headersSent = true;
      if (chunk !== undefined) captured.body += chunk;
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

function fakeReq(method: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  return Object.assign(stream, { method, headers: {} }) as unknown as IncomingMessage;
}

describe('api/health (Vercel)', () => {
  before(async () => {
    // The module reads config at import time; env is set above.
    await import('../api/health.ts');
  });

  it('reports ok and the demo flag', async () => {
    const { default: handler } = await import('../api/health.ts');
    const { res, captured } = fakeRes();
    handler(fakeReq('GET'), res);

    assert.equal(captured.status, 200);
    assert.match(captured.headers['content-type'] ?? '', /application\/json/);

    const body = JSON.parse(captured.body) as {
      status: string;
      demo: boolean;
      defaultModel: string;
      provider: string;
      auth: boolean;
    };
    assert.equal(body.status, 'ok');
    // AI_PROVIDER=mock in this suite, so the UI banner path is what we assert.
    assert.equal(body.demo, true);
    assert.equal(body.provider, 'mock');
    assert.equal(body.defaultModel, 'OpenRouter Free');

    // The frontend reads this to decide whether to call /api/auth/* at all.
    // Without it, every page load probes an endpoint that may not exist.
    assert.equal(typeof body.auth, 'boolean', 'health must advertise the auth capability');
  });

    it('never echoes a key, base URL or database path', async () => {    const { default: handler } = await import('../api/health.ts');
    const { res, captured } = fakeRes();
    handler(fakeReq('GET'), res);

    assert.doesNotMatch(captured.body, /AI_API_KEY|apiKey|baseUrl|databasePath|\.db/i);
  });

  it('rejects a non-GET method with 405', async () => {    const { default: handler } = await import('../api/health.ts');
    const { res, captured } = fakeRes();
    handler(fakeReq('POST'), res);

    assert.equal(captured.status, 405);
    assert.equal(captured.headers.allow, 'GET, OPTIONS');
  });
});

describe('api/chat (Vercel)', () => {
  before(async () => {
    await import('../api/chat.ts');
  });

  after(() => {
    // nothing to tear down; the handler holds no listeners
  });

  it('rejects a non-POST method with 405 and an Allow header', async () => {
    const { default: handler } = await import('../api/chat.ts');
    const { res, captured } = fakeRes();
    await handler(fakeReq('GET'), res);

    assert.equal(captured.status, 405);
    assert.equal(captured.headers.allow, 'POST');
    const body = JSON.parse(captured.body) as { error: { code: string } };
    assert.equal(body.error.code, 'method_not_allowed');
  });

  it('rejects an empty message with 400 before streaming anything', async () => {
    const { default: handler } = await import('../api/chat.ts');
    const { res, captured } = fakeRes();
    await handler(fakeReq('POST', { message: '   ' }), res);

    assert.equal(captured.status, 400);
    const body = JSON.parse(captured.body) as { error: { code: string } };
    assert.equal(body.error.code, 'bad_request');
    assert.doesNotMatch(captured.headers['content-type'] ?? '', /event-stream/);
  });

  it('rejects an unknown model label with unknown_model', async () => {
    const { default: handler } = await import('../api/chat.ts');
    const { res, captured } = fakeRes();
    await handler(fakeReq('POST', { message: 'hi', model: 'Not-A-Model' }), res);

    assert.equal(captured.status, 400);
    const body = JSON.parse(captured.body) as { error: { code: string } };
    assert.equal(body.error.code, 'unknown_model');
  });

  it('streams meta then delta then done for a valid turn', async () => {
    const { default: handler } = await import('../api/chat.ts');
    const { res, captured } = fakeRes();
    await handler(fakeReq('POST', { message: 'hello there' }), res);

    assert.equal(captured.status, 200);
    assert.match(captured.headers['content-type'] ?? '', /text\/event-stream/);

    const names = [...captured.body.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    assert.equal(names[0], 'meta');
    assert.equal(names[names.length - 1], 'done');
  });

  it('routes every retired default label to the default provider', async () => {
    const { default: handler } = await import('../api/chat.ts');

    // The default model has been renamed twice. Conversations saved under the
    // older labels must keep working rather than 400-ing as unknown_model.
    for (const label of ['OpenRouter Free', 'SpaceBunny Free MAX', 'ChatBot AI', '']) {
      const { res, captured } = fakeRes();
      await handler(fakeReq('POST', { message: 'hi', model: label }), res);

      assert.equal(captured.status, 200, `"${label}" should reach the default provider`);
      assert.match(captured.headers['content-type'] ?? '', /event-stream/);
    }
  });

  it('omits the model entirely and still routes to the default provider', async () => {
    const { default: handler } = await import('../api/chat.ts');
    const { res, captured } = fakeRes();
    await handler(fakeReq('POST', { message: 'hi' }), res);

    assert.equal(captured.status, 200);
    assert.match(captured.headers['content-type'] ?? '', /event-stream/);
  });
});
