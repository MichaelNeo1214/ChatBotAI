import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConversationBody, CookieJar, TestServer } from './helpers.ts';
import type { ConversationRow } from '../src/db/index.ts';

process.env.DATABASE_PATH = path.join(tmpdir(), `chatbotai-persona-${randomUUID()}.db`);
process.env.AI_PROVIDER = 'mock';

const { CookieJar: Jar, createTestServer, payloadsOf, readSse } = await import('./helpers.ts');
const { DEFAULT_SYSTEM_PROMPT, PERSONALITIES, findPersonality } =
  await import('../src/chat/personalities.ts');

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
  error: { message: string; status: number; code?: string; personality?: string };
}

const coder = findPersonality('coder')!;

async function create(body: unknown): Promise<Response> {
  return owner.post('/api/conversations', body);
}

async function createdRow(body: unknown): Promise<ConversationRow> {
  const res = await create(body);
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return (JSON.parse(text) as { conversation: ConversationRow }).conversation;
}

describe('GET /api/personalities', () => {
  test('lists the built-in personas with full prompts', async () => {
    const res = await owner.get('/api/personalities');
    assert.equal(res.status, 200);
    const { personalities } = (await res.json()) as { personalities: typeof PERSONALITIES };

    assert.deepEqual(personalities, PERSONALITIES);
    const ids = personalities.map((p) => p.id);
    assert.ok(ids.includes('default'));
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
    for (const p of personalities) {
      assert.ok(p.name && p.description && p.prompt, `${p.id} is fully described`);
    }
    assert.equal(findPersonality('default')?.prompt, DEFAULT_SYSTEM_PROMPT);
  });
});

describe('POST /api/conversations — persona', () => {
  test('no persona means no system prompt', async () => {
    const row = await createdRow({});
    assert.equal(row.system_prompt, null);
  });

  test('a built-in personality stores its prompt', async () => {
    const row = await createdRow({ personality: 'coder' });
    assert.equal(row.system_prompt, coder.prompt);
  });

  test('the default personality is stored as no prompt', async () => {
    const row = await createdRow({ personality: 'default' });
    assert.equal(row.system_prompt, null);
  });

  test('a custom systemPrompt is trimmed and stored', async () => {
    const row = await createdRow({ systemPrompt: '  Speak like a pirate.  ' });
    assert.equal(row.system_prompt, 'Speak like a pirate.');
  });

  test('rejects both fields together, unknown ids, wrong types and oversized prompts', async () => {
    const both = await create({ personality: 'coder', systemPrompt: 'x' });
    assert.equal(both.status, 400);

    const unknown = await create({ personality: 'nope' });
    assert.equal(unknown.status, 400);
    const body = (await unknown.json()) as ErrorBody;
    assert.equal(body.error.code, 'unknown_personality');
    assert.equal(body.error.personality, 'nope');

    assert.equal((await create({ personality: 42 })).status, 400);
    assert.equal((await create({ systemPrompt: ['x'] })).status, 400);
    assert.equal((await create({ systemPrompt: 'x'.repeat(4_001) })).status, 400);
    assert.equal((await create({ systemPrompt: 'x'.repeat(4_000) })).status, 201);
  });
});

describe('PATCH /api/conversations/:id — persona', () => {
  test('sets, replaces and clears the prompt', async () => {
    const row = await createdRow({});
    const url = `/api/conversations/${row.id}`;

    let res = await owner.patch(url, { systemPrompt: 'Be brief.' });
    assert.equal(res.status, 200);
    let { conversation } = (await res.json()) as { conversation: ConversationRow };
    assert.equal(conversation.system_prompt, 'Be brief.');
    assert.equal(conversation.title, row.title, 'title untouched');

    res = await owner.patch(url, { personality: 'coder' });
    ({ conversation } = (await res.json()) as { conversation: ConversationRow });
    assert.equal(conversation.system_prompt, coder.prompt);

    res = await owner.patch(url, { systemPrompt: null });
    ({ conversation } = (await res.json()) as { conversation: ConversationRow });
    assert.equal(conversation.system_prompt, null);

    res = await owner.patch(url, { personality: 'coder' });
    res = await owner.patch(url, { personality: 'default' });
    ({ conversation } = (await res.json()) as { conversation: ConversationRow });
    assert.equal(conversation.system_prompt, null, '"default" clears too');

    res = await owner.patch(url, { systemPrompt: '   ' });
    ({ conversation } = (await res.json()) as { conversation: ConversationRow });
    assert.equal(conversation.system_prompt, null, 'blank clears too');
  });

  test('title and persona can change in one request', async () => {
    const row = await createdRow({});
    const res = await owner.patch(`/api/conversations/${row.id}`, {
      title: 'Pair programming',
      personality: 'coder',
    });
    assert.equal(res.status, 200);
    const { conversation } = (await res.json()) as { conversation: ConversationRow };
    assert.equal(conversation.title, 'Pair programming');
    assert.equal(conversation.system_prompt, coder.prompt);
  });

  test('an empty body is a 400, and a bad title still is', async () => {
    const row = await createdRow({});
    assert.equal((await owner.patch(`/api/conversations/${row.id}`, {})).status, 400);
    assert.equal(
      (await owner.patch(`/api/conversations/${row.id}`, { title: '', personality: 'coder' })).status,
      400,
    );
  });

  test('another owner cannot change the persona', async () => {
    const row = await createdRow({});
    const res = await other.patch(`/api/conversations/${row.id}`, { personality: 'coder' });
    assert.equal(res.status, 404);
    const check = await owner.get(`/api/conversations/${row.id}`);
    const { conversation } = (await check.json()) as ConversationBody;
    assert.equal(conversation.system_prompt, null);
  });
});

describe('POST /api/chat — persona', () => {
  test('a first turn can pick the persona for the new conversation', async () => {
    const res = await owner.post('/api/chat', { message: 'Write hello world', personality: 'coder' });
    assert.equal(res.status, 200);
    const events = await readSse(res);
    const meta = payloadsOf<{ conversationId: string }>(events, 'meta')[0]!;

    const fetched = await owner.get(`/api/conversations/${meta.conversationId}`);
    const { conversation } = (await fetched.json()) as ConversationBody;
    assert.equal(conversation.system_prompt, coder.prompt);
  });

  test('a persona on a later turn is refused and nothing is written', async () => {
    const row = await createdRow({});
    const res = await owner.post('/api/chat', {
      message: 'Hi',
      conversationId: row.id,
      personality: 'coder',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, 'persona_on_existing_conversation');

    const fetched = await owner.get(`/api/conversations/${row.id}`);
    const { conversation, messages } = (await fetched.json()) as ConversationBody;
    assert.equal(conversation.system_prompt, null);
    assert.equal(messages.length, 0);
  });
});

describe('providers honour the conversation prompt', () => {
  test('openai-compatible sends the custom prompt, or the default when unset', async () => {
    const { OpenAICompatibleProvider } = await import('../src/providers/openai-compatible.ts');
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://upstream.test/v1',
      apiKey: 'k',
      model: 'm',
    });

    const seen: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;

    try {
      const drain = async (system?: string) => {
        for await (const _chunk of provider.streamChat({
          messages: [{ role: 'user', content: 'hi' }],
          system,
        })) {
          // nothing streams from the stub; we only care about the request
        }
      };
      await drain('Be brief.');
      await drain();
    } finally {
      globalThis.fetch = realFetch;
    }

    const systemOf = (body: unknown) =>
      (body as { messages: { role: string; content: string }[] }).messages[0];
    assert.deepEqual(systemOf(seen[0]), { role: 'system', content: 'Be brief.' });
    assert.deepEqual(systemOf(seen[1]), { role: 'system', content: DEFAULT_SYSTEM_PROMPT });
  });
});
