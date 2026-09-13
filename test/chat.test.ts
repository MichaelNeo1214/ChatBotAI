import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CookieJar, TestServer } from './helpers.ts';

// src/config.ts, src/db/index.ts and src/providers/index.ts read the
// environment the first time they are evaluated, so these have to be in place
// before anything under src/ is imported — which is why the import below is
// dynamic rather than static.
process.env.DATABASE_PATH = path.join(tmpdir(), `chatbotai-chat-${randomUUID()}.db`);
process.env.AI_PROVIDER = 'mock';

const { CookieJar: Jar, createTestServer, eventNames, joinDeltas, payloadsOf, readSse } =
  await import('./helpers.ts');

let server: TestServer;
let anon: CookieJar;

before(async () => {
  server = await createTestServer();
  anon = new Jar({ baseUrl: server.baseUrl, name: 'anon' });
});

after(async () => {
  await server.close();
});

const chat = (jar: CookieJar, body: unknown) => jar.post('/api/chat', body);

describe('POST /api/chat — the SSE turn', () => {
  test('a first message creates a conversation and streams meta, deltas, done', async () => {
    const res = await chat(anon, { message: 'Hello there' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const events = await readSse(res);
    const names = eventNames(events);

    assert.equal(names[0], 'meta');
    assert.equal(names.at(-1), 'done');

    const meta = payloadsOf<{ conversationId: string; messageId: string }>(events, 'meta')[0];
    assert.ok(meta, 'expected a meta event');
    assert.match(meta.conversationId, /^[0-9a-f-]{36}$/i);

    const deltas = payloadsOf<{ text: string }>(events, 'delta');
    assert.ok(deltas.length >= 1, 'expected at least one delta');
    assert.ok(deltas.every((delta) => typeof delta.text === 'string'));
    assert.equal(deltas.length, names.filter((name) => name === 'delta').length);

    const done = payloadsOf<{ messageId: string; content: string }>(events, 'done')[0];
    assert.ok(done, 'expected a done event');
    assert.equal(done.content, joinDeltas(events));
    assert.notEqual(done.content, '');
  });

  test('conversationId: null is accepted as "start a new conversation"', async () => {
    const res = await chat(anon, { message: 'Null conversation id', conversationId: null });
    assert.equal(res.status, 200);

    const events = await readSse(res);
    assert.deepEqual(eventNames(events)[0], 'meta');
    assert.deepEqual(eventNames(events).at(-1), 'done');
  });

  test('a follow-up appends to the conversation: four messages, alternating roles', async () => {
    const first = await chat(anon, { message: 'First turn' });
    const firstEvents = await readSse(first);
    const { conversationId } = payloadsOf<{ conversationId: string }>(firstEvents, 'meta')[0]!;

    const second = await chat(anon, { message: 'Second turn', conversationId });
    assert.equal(second.status, 200);
    const secondEvents = await readSse(second);
    assert.equal(eventNames(secondEvents).at(-1), 'done');
    assert.equal(
      payloadsOf<{ conversationId: string }>(secondEvents, 'meta')[0]!.conversationId,
      conversationId,
      'a follow-up must resolve to the same conversation',
    );

    const detail = await anon.get(`/api/conversations/${conversationId}`);
    assert.equal(detail.status, 200);
    const body = (await detail.json()) as {
      messages: { role: string; content: string }[];
    };

    assert.deepEqual(
      body.messages.map((message) => message.role),
      ['user', 'assistant', 'user', 'assistant'],
    );
    assert.equal(body.messages[0]!.content, 'First turn');
    assert.equal(body.messages[2]!.content, 'Second turn');
    assert.equal(
      body.messages[1]!.content,
      payloadsOf<{ content: string }>(firstEvents, 'done')[0]!.content,
    );
  });

  test('the title is the first message trimmed, and the model label is stored', async () => {
    const message = '   Title comes from here   ';
    const res = await chat(anon, { message });
    const events = await readSse(res);
    const { conversationId } = payloadsOf<{ conversationId: string }>(events, 'meta')[0]!;

    const detail = await anon.get(`/api/conversations/${conversationId}`);
    const { conversation } = (await detail.json()) as {
      conversation: { title: string; model: string };
    };

    assert.equal(conversation.title, message.trim());
    assert.equal(typeof conversation.model, 'string');
    assert.notEqual(conversation.model, '', 'the conversation should record a model label');
  });

  test('a model sent with the message is stored on the conversation', async () => {
    const res = await chat(anon, { message: 'Pick a model please', model: 'local-test-model' });
    const { conversationId } = payloadsOf<{ conversationId: string }>(
      await readSse(res),
      'meta',
    )[0]!;

    const detail = await anon.get(`/api/conversations/${conversationId}`);
    const { conversation } = (await detail.json()) as { conversation: { model: string } };
    assert.equal(conversation.model, 'local-test-model');
  });
});

describe('POST /api/chat — validation', () => {
  test('a whitespace-only message is a 400', async () => {
    const res = await chat(anon, { message: '   \n\t ' });
    assert.equal(res.status, 400);
  });

  test('a missing message is a 400', async () => {
    const res = await chat(anon, {});
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string; status: number } };
    assert.equal(body.error.status, 400);
  });

  test('a message over 32000 characters is a 400', async () => {
    const res = await chat(anon, { message: 'a'.repeat(32_001) });
    assert.equal(res.status, 400);
  });

  test('a message of exactly 32000 characters is accepted', async () => {
    const res = await chat(anon, { message: 'b'.repeat(32_000) });
    assert.equal(res.status, 200);
    await res.text();
  });

  test('conversationId: 42 is a 400', async () => {
    const res = await chat(anon, { message: 'Bad id type', conversationId: 42 });
    assert.equal(res.status, 400);
  });

  test('an unknown conversation UUID is a 404', async () => {
    const res = await chat(anon, { message: 'No such conversation', conversationId: randomUUID() });
    assert.equal(res.status, 404);
  });
});
