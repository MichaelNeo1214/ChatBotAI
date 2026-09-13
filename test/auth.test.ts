import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CookieJar, TestServer } from './helpers.ts';

// src/config.ts reads the environment the first time it is evaluated, so the
// database path has to be set before anything under src/ is imported — hence
// the dynamic import below.
process.env.DATABASE_PATH = path.join(tmpdir(), `chatbotai-auth-${randomUUID()}.db`);
process.env.AI_PROVIDER = 'mock';
const dbPath = process.env.DATABASE_PATH;

const { CookieJar: Jar, createTestServer, payloadsOf, readSse } = await import('./helpers.ts');

let server: TestServer;

before(async () => {
  server = await createTestServer();
});

after(async () => {
  await server.close();
});

let uniqueCounter = 0;
function freshJar(label: string): CookieJar {
  uniqueCounter += 1;
  return new Jar({ baseUrl: server.baseUrl, name: `${label}-${uniqueCounter}` });
}

function freshEmail(label: string): string {
  return `${label}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
}

interface PublicUser {
  id: string;
  email: string;
  name: string;
}

interface Conversation {
  id: string;
  title: string;
  model: string;
}

interface ConversationList {
  conversations: Conversation[];
}

interface ConversationDetail {
  conversation: Conversation;
  messages: { role: string; content: string }[];
}

async function chatOnce(jar: CookieJar, message: string): Promise<string> {
  const res = await jar.post('/api/chat', { message });
  assert.equal(res.status, 200);
  const { conversationId } = payloadsOf<{ conversationId: string }>(await readSse(res), 'meta')[0]!;
  return conversationId;
}

async function signup(jar: CookieJar, body: unknown): Promise<Response> {
  return jar.post('/api/auth/signup', body);
}

/** Signs up a throwaway account and returns its credentials and identity. */
async function newAccount(label: string): Promise<{
  jar: CookieJar;
  email: string;
  password: string;
  name: string;
  user: PublicUser;
}> {
  const jar = freshJar(label);
  const email = freshEmail(label);
  const password = `pw-${label}-12345678`;
  const name = `User ${label}`;

  const res = await signup(jar, { email, password, name });
  assert.equal(res.status, 201);
  const { user } = (await res.json()) as { user: PublicUser };

  return { jar, email, password, name, user };
}

describe('POST /api/auth/signup — validation', () => {
  test('a password under 8 characters is a 400', async () => {
    const res = await signup(freshJar('short'), {
      email: freshEmail('short'),
      password: '1234567',
      name: 'Shorty',
    });
    assert.equal(res.status, 400);
  });

  test('an invalid email is a 400', async () => {
    for (const email of ['not-an-email', 'missing@domain', 'two @spaces.com', '']) {
      const res = await signup(freshJar('bad-email'), {
        email,
        password: 'longenough123',
        name: 'Bad Email',
      });
      assert.equal(res.status, 400, `expected 400 for email "${email}"`);
    }
  });

  test('a missing name is a 400', async () => {
    const res = await signup(freshJar('no-name'), {
      email: freshEmail('no-name'),
      password: 'longenough123',
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/auth/signup — success', () => {
  test('returns 201 with a public user and sets the session cookie', async () => {
    const jar = freshJar('signup');
    const email = freshEmail('signup');
    const res = await signup(jar, { email, password: 'longenough123', name: 'Alice' });

    assert.equal(res.status, 201);
    const body = (await res.json()) as { user: Record<string, unknown> };
    assert.equal(typeof body.user.id, 'string');
    assert.equal(body.user.email, email);
    assert.equal(body.user.name, 'Alice');
    assert.ok(!('password_hash' in body.user), 'password_hash must never be serialized');
    assert.ok(!JSON.stringify(body).includes('longenough123'));

    const cookies = res.headers.getSetCookie();
    const session = cookies.find((cookie) => cookie.startsWith('cbai_session='));
    assert.ok(session, `expected a cbai_session cookie, got: ${JSON.stringify(cookies)}`);
    assert.match(session, /HttpOnly/i);
    assert.ok(jar.cookie('cbai_session'), 'the jar should have stored the session');
  });

  test('a duplicate email in a different case is a 409', async () => {
    const account = await newAccount('dup');
    const res = await signup(freshJar('dup-second'), {
      email: account.email.toUpperCase(),
      password: 'longenough123',
      name: 'Impostor',
    });
    assert.equal(res.status, 409);
  });
});

describe('anonymous chats are claimed on signup', () => {
  test('a conversation started anonymously follows the browser into the new account', async () => {
    const jar = freshJar('claim');
    const conversationId = await chatOnce(jar, 'Chatting before I sign up');

    const res = await signup(jar, {
      email: freshEmail('claim'),
      password: 'longenough123',
      name: 'Claimer',
    });
    assert.equal(res.status, 201);

    const body = (await res.json()) as { claimedConversations?: number };
    assert.equal(body.claimedConversations, 1);

    const list = await jar.get('/api/conversations');
    const { conversations } = (await list.json()) as ConversationList;
    assert.deepEqual(
      conversations.map((conversation) => conversation.id),
      [conversationId],
    );
    assert.equal(conversations[0]!.title, 'Chatting before I sign up');
  });
});

describe('POST /api/auth/login', () => {
  test('a wrong password is a 401, and the email is case-insensitive', async () => {
    const account = await newAccount('login');

    const wrong = await freshJar('login-wrong').post('/api/auth/login', {
      email: account.email,
      password: 'definitely-wrong',
    });
    assert.equal(wrong.status, 401);

    const jar = freshJar('login-ok');
    const ok = await jar.post('/api/auth/login', {
      email: account.email.toUpperCase(),
      password: account.password,
    });
    assert.equal(ok.status, 200);
    const { user } = (await ok.json()) as { user: PublicUser };
    assert.equal(user.id, account.user.id);
    assert.equal(user.email, account.email, 'the stored casing is returned');
    assert.ok(jar.cookie('cbai_session'));
  });

  test('history follows the account to a second browser', async () => {
    const account = await newAccount('follow');
    const conversationId = await chatOnce(account.jar, 'Only on the first browser');

    const second = freshJar('follow-second');
    const login = await second.post('/api/auth/login', {
      email: account.email,
      password: account.password,
    });
    assert.equal(login.status, 200);

    const list = await second.get('/api/conversations');
    const { conversations } = (await list.json()) as ConversationList;
    assert.deepEqual(
      conversations.map((conversation) => conversation.id),
      [conversationId],
    );
  });
});

describe('GET /api/auth/me and logout', () => {
  test('me reports the session, logout clears it', async () => {
    const account = await newAccount('me');

    const me = await account.jar.get('/api/auth/me');
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as { user: PublicUser | null };
    assert.equal(meBody.user?.id, account.user.id);
    assert.ok(meBody.user && !('password_hash' in (meBody.user as Record<string, unknown>)));

    const logout = await account.jar.post('/api/auth/logout');
    assert.equal(logout.status, 204);

    const after = await account.jar.get('/api/auth/me');
    assert.deepEqual(await after.json(), { user: null });

    const list = await account.jar.get('/api/conversations');
    assert.deepEqual(((await list.json()) as ConversationList).conversations, []);
  });
});

describe('account isolation', () => {
  test('a second account cannot see the first account\'s conversation', async () => {
    const first = await newAccount('iso-first');
    const conversationId = await chatOnce(first.jar, 'Belongs to the first account');

    const second = await newAccount('iso-second');
    assert.equal((await second.jar.get(`/api/conversations/${conversationId}`)).status, 404);
    assert.deepEqual(
      ((await (await second.jar.get('/api/conversations')).json()) as ConversationList).conversations,
      [],
    );

    // And the owner still has it.
    const detail = await first.jar.get(`/api/conversations/${conversationId}`);
    assert.equal(detail.status, 200);
    assert.equal(((await detail.json()) as ConversationDetail).conversation.id, conversationId);
  });
});

describe('login rate limiting', () => {
  test('the 11th failed attempt for one email is a 429 with Retry-After', async () => {
    // A fresh, unregistered email: /signup and /login share one attempt bucket
    // per (IP, email), so signing an account up first would consume one of the
    // ten allowed attempts before the loop below even starts.
    const email = freshEmail('ratelimit-target');
    const jar = freshJar('ratelimit-jar');

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const res = await jar.post('/api/auth/login', { email, password: 'wrong-password' });
      statuses.push(res.status);
      if (res.status === 429) {
        assert.ok(
          Number(res.headers.get('retry-after')) > 0,
          'a 429 must carry a positive Retry-After',
        );
      }
    }

    // The limiter allows 10 attempts per window; the 11th is refused.
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.equal(statuses[10], 429);

    // The bucket is keyed by IP *and* email, so another account is unaffected.
    const other = await freshJar('ratelimit-other').post('/api/auth/login', {
      email: freshEmail('ratelimit-other'),
      password: 'wrong-password',
    });
    assert.equal(other.status, 401);
  });
});

describe('stored credentials', () => {
  test('tokens are hashed, passwords are scrypt, and no plaintext is written', async () => {
    const password = 'plaintext-must-not-land-in-the-db-9876';
    const email = freshEmail('storage');
    const res = await signup(freshJar('storage'), { email, password, name: 'Storage Tester' });
    assert.equal(res.status, 201);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const session = db.prepare('SELECT token_hash FROM sessions').all() as unknown as {
        token_hash: string;
      }[];
      assert.ok(session.length >= 1, 'signup should have created a session');
      for (const row of session) {
        assert.match(row.token_hash, /^[0-9a-f]{64}$/, 'token_hash must be a sha-256 hex digest');
      }

      const users = db.prepare('SELECT password_hash FROM users').all() as unknown as {
        password_hash: string;
      }[];
      const mine = users.filter((row) => row.password_hash.startsWith('scrypt$'));
      assert.ok(mine.length >= 1, 'passwords must be stored as scrypt hashes');
      for (const row of users) {
        assert.ok(row.password_hash.startsWith('scrypt$'), row.password_hash.slice(0, 20));
      }
    } finally {
      db.close();
    }

    const raw = readFileSync(dbPath, 'latin1');
    assert.equal(raw.includes(password), false, 'the plaintext password must not appear in the DB');
  });
});
