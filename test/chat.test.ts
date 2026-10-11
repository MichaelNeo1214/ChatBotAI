import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CookieJar, SseEvent, TestServer } from './helpers.ts';

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

  test('the default model label sent with a message is stored on the conversation', async () => {
    // 'ChatBot AI' is the server's own default label (DEFAULT_MODEL_LABEL), so
    // it resolves to the boot-time provider. Any other label is a BYOK preset
    // and needs an X-Provider-Key, which is why this is not a made-up string.
    const res = await chat(anon, { message: 'Pick a model please', model: 'ChatBot AI' });
    assert.equal(res.status, 200);

    const { conversationId } = payloadsOf<{ conversationId: string }>(
      await readSse(res),
      'meta',
    )[0]!;

    const detail = await anon.get(`/api/conversations/${conversationId}`);
    const { conversation } = (await detail.json()) as { conversation: { model: string } };
    assert.equal(conversation.model, 'ChatBot AI');
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

// A 1x1 PNG. Real bytes, so the magic-byte sniffing in parseAttachments is
// exercised rather than bypassed by a hand-written base64 string.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('POST /api/chat — attachments', () => {
  // Its own cookie jar: these turns exist to prove a payload is accepted, and
  // reusing `anon` would spend the per-owner rate-limit cap shared with the
  // suites above.
  let mm: CookieJar;

  before(() => {
    mm = new Jar({ baseUrl: server.baseUrl, name: 'attachments' });
  });

  // The mock provider emits many deltas, so only the frame order is asserted.
  function assertStreamShape(events: SseEvent[]): void {
    const names = eventNames(events);
    assert.equal(names[0], 'meta', 'meta must be the first frame');
    assert.equal(names[names.length - 1], 'done', 'done must be the last frame');
    assert.equal(names.filter((n) => n === 'error').length, 0, 'no error frame');
  }

  test('a text-only turn still succeeds with no attachments field', async () => {
    const res = await chat(mm, { message: 'plain text only' });
    assert.equal(res.status, 200);
    assertStreamShape(await readSse(res));
  });

  test('an image attachment is accepted and the turn still completes', async () => {
    const res = await chat(mm, {
      message: 'What is in this picture?',
      attachments: { images: [{ mimeType: 'image/png', data: PNG_1PX }] },
    });
    assert.equal(res.status, 200);
    assertStreamShape(await readSse(res));
  });

  test('a data URL image is accepted in place of a bare base64 payload', async () => {
    const res = await chat(mm, {
      message: 'Describe this',
      attachments: { images: [`data:image/png;base64,${PNG_1PX}`] },
    });
    assert.equal(res.status, 200);
    await res.text();
  });

  test('the flat { file } shape with an image type is accepted', async () => {
    const res = await chat(mm, {
      message: 'Flat shape',
      attachments: { file: { type: 'image/png', data: PNG_1PX } },
    });
    assert.equal(res.status, 200);
    await res.text();
  });

  test('a text document is folded into the prompt but not persisted', async () => {
    const res = await chat(mm, {
      message: 'Summarise the notes',
      attachments: { document: { name: 'notes.md', text: '# Heading\nremember the milk' } },
    });
    assert.equal(res.status, 200);
    const events = await readSse(res);
    const { conversationId } = payloadsOf<{ conversationId: string }>(events, 'meta')[0]!;

    // The stored transcript must show only what the user typed, so the sidebar
    // and any re-opened thread stay readable.
    const detail = await mm.get(`/api/conversations/${conversationId}`);
    const { messages } = (await detail.json()) as {
      messages: { role: string; content: string }[];
    };
    const user = messages.find((m) => m.role === 'user');
    assert.ok(user, 'the user turn should be persisted');
    assert.equal(user!.content, 'Summarise the notes');
    assert.ok(
      !user!.content.includes('remember the milk'),
      'the injected document text must not leak into the stored transcript',
    );
  });

  test('a document is allowed even when the message is short enough to fail alone', async () => {
    // The 32000-char limit applies to the typed message. The document is a
    // separate field, so a large attachment must not turn a valid turn into a
    // 400, and must not be silently dropped either.
    const res = await chat(mm, {
      message: 'Read this',
      attachments: { document: { name: 'big.txt', text: 'x'.repeat(80_000) } },
    });
    assert.equal(res.status, 200);
    await res.text();
  });

  test('a corrupt or non-image payload is dropped, not fatal', async () => {
    const res = await chat(mm, {
      message: 'Broken image',
      attachments: { images: [{ mimeType: 'image/png', data: 'not-real-base64!!' }] },
    });
    assert.equal(res.status, 200, 'one bad file must not fail the turn');
    await res.text();
  });

  test('an SVG masquerading as an image is rejected (no script-bearing vector)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64');
    const res = await chat(mm, {
      message: 'Vector',
      attachments: { images: [{ mimeType: 'image/svg+xml', data: svg }] },
    });
    assert.equal(res.status, 200);
    await res.text();
  });

  test('more than four images are capped rather than failing the turn', async () => {
    const res = await chat(mm, {
      message: 'Too many',
      attachments: {
        images: Array.from({ length: 6 }, () => ({ mimeType: 'image/png', data: PNG_1PX })),
      },
    });
    assert.equal(res.status, 200);
    await res.text();
  });

  test('a garbage attachments field is ignored and the text turn still runs', async () => {
    const res = await chat(mm, {
      message: 'Weird payload',
      attachments: { images: 'nope', document: 42, file: true },
    });
    assert.equal(res.status, 200);
    await res.text();
  });
});
