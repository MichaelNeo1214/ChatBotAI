import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConversationListBody, CookieJar, TestServer } from './helpers.ts';

// Tiny caps so the limit is reachable in a handful of requests. Set before the
// dynamic import because src/config.ts reads the environment when evaluated.
process.env.DATABASE_PATH = path.join(tmpdir(), `chatbotai-ratelimit-${randomUUID()}.db`);
process.env.AI_PROVIDER = 'mock';
process.env.CHAT_RATE_LIMIT_WINDOW_MS = '60000';
process.env.CHAT_RATE_LIMIT_PER_OWNER = '3';
process.env.CHAT_RATE_LIMIT_PER_IP = '5';

const { CookieJar: Jar, createTestServer, readSse } = await import('./helpers.ts');

let server: TestServer;
let alice: CookieJar;
let bob: CookieJar;

before(async () => {
  server = await createTestServer();
  alice = new Jar({ baseUrl: server.baseUrl, name: 'alice' });
  bob = new Jar({ baseUrl: server.baseUrl, name: 'bob' });
});

after(async () => {
  await server.close();
});

const chat = (jar: CookieJar, message: string) => jar.post('/api/chat', { message });

interface RateLimitedBody {
  error: { message: string; status: number; code: string; retryAfter: number };
}

describe('POST /api/chat — rate limiting', () => {
  test('one browser is cut off after its per-owner cap', async () => {
    for (let i = 1; i <= 3; i += 1) {
      const res = await chat(alice, `message ${i}`);
      assert.equal(res.status, 200, `request ${i} should stream`);
      await readSse(res); // drain so the server finishes the turn
    }

    const res = await chat(alice, 'one too many');
    assert.equal(res.status, 429);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);

    const retryAfter = Number(res.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60);

    const body = (await res.json()) as RateLimitedBody;
    assert.equal(body.error.code, 'rate_limited');
    assert.equal(body.error.status, 429);
    assert.equal(body.error.retryAfter, retryAfter);
    assert.equal(typeof body.error.message, 'string');
  });

  test('a rejected turn is not persisted', async () => {
    const res = await alice.get('/api/conversations');
    const { conversations } = (await res.json()) as ConversationListBody;
    assert.equal(conversations.length, 3, 'only the three accepted turns exist');
    assert.ok(conversations.every((c) => c.title !== 'one too many'));
  });

  test('other endpoints are unaffected for a rate-limited owner', async () => {
    const health = await alice.get('/api/health');
    assert.equal(health.status, 200);

    const created = await alice.post('/api/conversations', {});
    assert.equal(created.status, 201);
  });

  test('another browser on the same IP is still served until the per-IP cap', async () => {
    // Alice used 3 of the 5 IP slots; her rejected 4th never reached the IP
    // limiter, so Bob gets exactly two turns.
    for (let i = 1; i <= 2; i += 1) {
      const res = await chat(bob, `bob ${i}`);
      assert.equal(res.status, 200, `bob's request ${i} should stream`);
      await readSse(res);
    }

    const res = await chat(bob, 'bob 3');
    assert.equal(res.status, 429);
    const body = (await res.json()) as RateLimitedBody;
    assert.equal(body.error.code, 'rate_limited');
  });
});
