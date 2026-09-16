import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConversationBody, CookieJar, TestServer } from './helpers.ts';
import type { ConversationRow, MessageRow } from '../src/db/index.ts';

process.env.DATABASE_PATH = path.join(tmpdir(), `chatbotai-regen-${randomUUID()}.db`);
process.env.AI_PROVIDER = 'mock';

const { CookieJar: Jar, createTestServer, eventNames, payloadsOf, readSse } =
  await import('./helpers.ts');

let server: TestServer;
let owner: CookieJar;
let other: CookieJar;

before(async () => {
  server = await createTestServer();
  owner = new Jar({ baseUrl: server.baseUrl, name: 'owner' });
  other = new Jar({ baseUrl: server.baseUrl, name: 'other' });
});

after(async () => {
  await server.close();
});

interface ErrorBody {
  error: { message: string; status: number; code?: string };
}
interface Meta {
  conversationId: string;
  model: string;
  replaced: string | null;
}
interface Done {
  messageId: string;
  content: string;
}

/** One full turn; returns the conversation id. */
async function chat(jar: CookieJar, message: string, conversationId?: string): Promise<string> {
  const res = await jar.post('/api/chat', { message, conversationId });
  assert.equal(res.status, 200);
  const events = await readSse(res);
  return payloadsOf<Meta>(events, 'meta')[0]!.conversationId;
}

async function messagesOf(jar: CookieJar, id: string): Promise<MessageRow[]> {
  const res = await jar.get(`/api/conversations/${id}`);
  assert.equal(res.status, 200);
  return ((await res.json()) as ConversationBody).messages;
}

const regenerate = (jar: CookieJar, body: unknown) => jar.post('/api/chat/regenerate', body);

describe('POST /api/chat/regenerate', () => {
  test('replaces the last assistant reply and streams a new one', async () => {
    const id = await chat(owner, 'Tell me a joke');
    const before = await messagesOf(owner, id);
    assert.deepEqual(before.map((m) => m.role), ['user', 'assistant']);
    const oldReply = before[1]!;

    const res = await regenerate(owner, { conversationId: id });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const events = await readSse(res);
    assert.equal(eventNames(events)[0], 'meta');
    assert.equal(eventNames(events).at(-1), 'done');

    const meta = payloadsOf<Meta>(events, 'meta')[0]!;
    assert.equal(meta.conversationId, id);
    assert.equal(meta.replaced, oldReply.id);

    const done = payloadsOf<Done>(events, 'done')[0]!;
    assert.notEqual(done.messageId, oldReply.id);

    const after = await messagesOf(owner, id);
    assert.deepEqual(after.map((m) => m.role), ['user', 'assistant'], 'still one reply');
    assert.equal(after[0]!.id, before[0]!.id, 'the user message is untouched');
    assert.equal(after[1]!.id, done.messageId);
    assert.equal(after[1]!.content, done.content);
  });

  test('answers a trailing user message without deleting anything', async () => {
    const id = await chat(owner, 'First');
    const [, reply] = await messagesOf(owner, id);
    const del = await owner.delete(`/api/conversations/${id}/messages/${reply!.id}`);
    assert.equal(del.status, 204);
    assert.deepEqual((await messagesOf(owner, id)).map((m) => m.role), ['user']);

    const res = await regenerate(owner, { conversationId: id });
    assert.equal(res.status, 200);
    const events = await readSse(res);
    assert.equal(payloadsOf<Meta>(events, 'meta')[0]!.replaced, null);
    assert.deepEqual((await messagesOf(owner, id)).map((m) => m.role), ['user', 'assistant']);
  });

  test('keeps earlier turns as context and only re-answers the last one', async () => {
    const id = await chat(owner, 'One');
    await chat(owner, 'Two', id);
    const before = await messagesOf(owner, id);
    assert.equal(before.length, 4);

    const res = await regenerate(owner, { conversationId: id });
    const events = await readSse(res);
    const done = payloadsOf<Done>(events, 'done')[0]!;
    // The mock echoes the message it answered.
    assert.match(done.content, /You said: "Two"/);

    const after = await messagesOf(owner, id);
    assert.equal(after.length, 4);
    assert.deepEqual(after.slice(0, 3).map((m) => m.id), before.slice(0, 3).map((m) => m.id));
  });

  test('a conversation with nothing to answer is a 400 and stays untouched', async () => {
    const created = await owner.post('/api/conversations', {});
    const { conversation } = (await created.json()) as { conversation: ConversationRow };

    const res = await regenerate(owner, { conversationId: conversation.id });
    assert.equal(res.status, 400);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, 'nothing_to_regenerate');
    assert.deepEqual(await messagesOf(owner, conversation.id), []);
  });

  test('validates the body', async () => {
    assert.equal((await regenerate(owner, {})).status, 400);
    assert.equal((await regenerate(owner, { conversationId: 5 })).status, 400);
    assert.equal((await regenerate(owner, { conversationId: 'x', model: 1 })).status, 400);
    assert.equal((await regenerate(owner, { conversationId: randomUUID() })).status, 404);
  });

  test("another owner cannot regenerate someone else's conversation", async () => {
    const id = await chat(owner, 'Private');
    const before = await messagesOf(owner, id);
    const res = await regenerate(other, { conversationId: id });
    assert.equal(res.status, 404);
    assert.deepEqual(await messagesOf(owner, id), before);
  });
});

describe('DELETE /api/conversations/:id/messages/:messageId', () => {
  test('removes one message and bumps updated_at', async () => {
    const id = await chat(owner, 'Delete me');
    const [user, reply] = await messagesOf(owner, id);
    const beforeRow = ((await (await owner.get(`/api/conversations/${id}`)).json()) as ConversationBody)
      .conversation;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const res = await owner.delete(`/api/conversations/${id}/messages/${user!.id}`);
    assert.equal(res.status, 204);

    const { conversation, messages } = (await (
      await owner.get(`/api/conversations/${id}`)
    ).json()) as ConversationBody;
    assert.deepEqual(messages.map((m) => m.id), [reply!.id]);
    assert.ok(conversation.updated_at > beforeRow.updated_at);
  });

  test('a missing, foreign or already-deleted message is a 404', async () => {
    const a = await chat(owner, 'A');
    const b = await chat(owner, 'B');
    const [msgB] = await messagesOf(owner, b);

    assert.equal((await owner.delete(`/api/conversations/${a}/messages/${msgB!.id}`)).status, 404);
    assert.equal((await owner.delete(`/api/conversations/${a}/messages/${randomUUID()}`)).status, 404);
    assert.equal((await messagesOf(owner, b)).length, 2, 'the foreign message survived');

    assert.equal((await owner.delete(`/api/conversations/${b}/messages/${msgB!.id}`)).status, 204);
    assert.equal((await owner.delete(`/api/conversations/${b}/messages/${msgB!.id}`)).status, 404);
  });

  test('another owner gets a 404 and deletes nothing', async () => {
    const id = await chat(owner, 'Mine');
    const [user] = await messagesOf(owner, id);
    assert.equal((await other.delete(`/api/conversations/${id}/messages/${user!.id}`)).status, 404);
    assert.equal((await messagesOf(owner, id)).length, 2);
  });
});
