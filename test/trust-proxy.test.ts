import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CookieJar, TestServer } from './helpers.ts';

// Behind a proxy every request arrives from the proxy's address. With
// TRUST_PROXY set, Express takes the client IP from X-Forwarded-For instead,
// which is what the per-IP rate limiter must key on. A per-IP cap of 1 makes
// that observable: two forwarded clients each get a turn.
process.env.DATABASE_PATH = path.join(tmpdir(), `chatbotai-proxy-${randomUUID()}.db`);
process.env.AI_PROVIDER = 'mock';
process.env.TRUST_PROXY = '1';
process.env.CHAT_RATE_LIMIT_PER_IP = '1';
process.env.CHAT_RATE_LIMIT_PER_OWNER = '10';

const { CookieJar: Jar, createTestServer, readSse } = await import('./helpers.ts');

let server: TestServer;
let jar: CookieJar;

before(async () => {
  server = await createTestServer();
  jar = new Jar({ baseUrl: server.baseUrl });
});

after(async () => {
  await server.close();
});

const chatFrom = (ip: string) =>
  jar.post('/api/chat', { message: `hello from ${ip}` }, { headers: { 'x-forwarded-for': ip } });

describe('TRUST_PROXY', () => {
  test('the per-IP limit keys on X-Forwarded-For', async () => {
    const first = await chatFrom('203.0.113.10');
    assert.equal(first.status, 200);
    await readSse(first);

    const second = await chatFrom('203.0.113.11');
    assert.equal(second.status, 200, 'a different forwarded client is not the same IP');
    await readSse(second);

    const repeat = await chatFrom('203.0.113.10');
    assert.equal(repeat.status, 429, 'the first forwarded client has used its turn');
  });
});
