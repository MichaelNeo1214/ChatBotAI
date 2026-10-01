import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CookieJar, TestServer } from './helpers.ts';

// src/config.ts (and therefore src/db/index.ts) reads the environment the first
// time it is evaluated, so the database path has to be set before anything
// under src/ is imported — hence the dynamic import below.
process.env.DATABASE_PATH = path.join(tmpdir(), `chatbotai-conversations-${randomUUID()}.db`);
process.env.AI_PROVIDER = 'mock';
const dbPath = process.env.DATABASE_PATH;

const { CookieJar: Jar, createTestServer, payloadsOf, readSse } = await import('./helpers.ts');

let server: TestServer;
let owner: CookieJar;
let other: CookieJar;

before(async () => {
  server = await createTestServer();
  owner = new Jar({ baseUrl: server.baseUrl, name: 'owner' });
  other = new Jar({ baseUrl: server.baseUrl, name: 'other-browser' });
});

after(async () => {
  await server.close();
});

interface Conversation {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
}

interface ConversationDetail {
  conversation: Conversation;
  messages: { id: string; role: string; content: string }[];
}

interface ConversationList {
  conversations: Conversation[];
}

async function startConversation(jar: CookieJar, message: string): Promise<Conversation> {
  const res = await jar.post('/api/chat', { message });
  assert.equal(res.status, 200);
  const { conversationId } = payloadsOf<{ conversationId: string }>(await readSse(res), 'meta')[0]!;
  const detail = await jar.get(`/api/conversations/${conversationId}`);
  assert.equal(detail.status, 200);
  return ((await detail.json()) as ConversationDetail).conversation;
}

/** Reads the temp database directly — the only way to prove a cascade works. */
function countMessages(conversationId: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?')
      .get(conversationId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}

describe('GET /api/conversations', () => {
  test('a fresh browser has an empty list', async () => {
    const res = await owner.get('/api/conversations');
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as ConversationList).conversations, []);
  });

  test('after a chat the conversation is listed, most recent first', async () => {
    const first = await startConversation(owner, 'Oldest conversation');
    const second = await startConversation(owner, 'Newest conversation');

    const res = await owner.get('/api/conversations');
    const { conversations } = (await res.json()) as ConversationList;

    const ids = conversations.map((conversation) => conversation.id);
    assert.deepEqual(ids.slice(0, 2), [second.id, first.id]);

    const listed = conversations.find((conversation) => conversation.id === second.id)!;
    assert.equal(listed.title, 'Newest conversation');

    await owner.delete(`/api/conversations/${first.id}`);
    await owner.delete(`/api/conversations/${second.id}`);
  });
});

describe('POST /api/conversations', () => {
  test('creates an empty conversation titled "New chat"', async () => {
    const res = await owner.post('/api/conversations', {});
    assert.equal(res.status, 201);

    const { conversation } = (await res.json()) as { conversation: Conversation };
    assert.equal(conversation.title, 'New chat');
    assert.equal(typeof conversation.id, 'string');
    assert.notEqual(conversation.model, '');

    await owner.delete(`/api/conversations/${conversation.id}`);
  });
});

describe('PATCH /api/conversations/:id', () => {
  test('renames a conversation', async () => {
    const conversation = await startConversation(owner, 'Rename me');

    const res = await owner.patch(`/api/conversations/${conversation.id}`, { title: 'Renamed' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { conversation: Conversation };
    assert.equal(body.conversation.title, 'Renamed');

    const detail = await owner.get(`/api/conversations/${conversation.id}`);
    assert.equal(((await detail.json()) as ConversationDetail).conversation.title, 'Renamed');

    await owner.delete(`/api/conversations/${conversation.id}`);
  });

  test('an empty title is a 400', async () => {
    const conversation = await startConversation(owner, 'Keep my title');

    const empty = await owner.patch(`/api/conversations/${conversation.id}`, { title: '' });
    assert.equal(empty.status, 400);

    const whitespace = await owner.patch(`/api/conversations/${conversation.id}`, { title: '   ' });
    assert.equal(whitespace.status, 400);

    await owner.delete(`/api/conversations/${conversation.id}`);
  });
});

describe('DELETE /api/conversations/:id', () => {
  test('deletes, then the conversation is gone', async () => {
    const conversation = await startConversation(owner, 'Delete me');

    const res = await owner.delete(`/api/conversations/${conversation.id}`);
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');

    const detail = await owner.get(`/api/conversations/${conversation.id}`);
    assert.equal(detail.status, 404);
  });

  test('deleting takes the conversation\'s messages with it', async () => {
    const conversation = await startConversation(owner, 'Messages must cascade');
    assert.equal(countMessages(conversation.id), 2, 'user + assistant should be stored');

    assert.equal((await owner.delete(`/api/conversations/${conversation.id}`)).status, 204);
    assert.equal(countMessages(conversation.id), 0);
  });
});

describe('ownership', () => {
  test('another browser cannot read, rename or delete the conversation, and lists nothing', async () => {
    const conversation = await startConversation(owner, 'Private conversation');

    const read = await other.get(`/api/conversations/${conversation.id}`);
    assert.equal(read.status, 404);

    const rename = await other.patch(`/api/conversations/${conversation.id}`, { title: 'Mine now' });
    assert.equal(rename.status, 404);

    const remove = await other.delete(`/api/conversations/${conversation.id}`);
    assert.equal(remove.status, 404);

    // None of the above may have touched the conversation.
    const detail = await owner.get(`/api/conversations/${conversation.id}`);
    assert.equal(detail.status, 200);
    assert.equal(((await detail.json()) as ConversationDetail).conversation.title, 'Private conversation');

    const list = await other.get('/api/conversations');
    assert.deepEqual(((await list.json()) as ConversationList).conversations, []);

    await owner.delete(`/api/conversations/${conversation.id}`);
  });
});
