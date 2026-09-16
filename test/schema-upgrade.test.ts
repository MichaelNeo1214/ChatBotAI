import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CookieJar, TestServer } from './helpers.ts';
import type { ConversationRow } from '../src/db/index.ts';

// A database created before system_prompt existed. Boot must add the column
// without touching the rows already there.
const dbPath = path.join(tmpdir(), `chatbotai-upgrade-${randomUUID()}.db`);
{
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE conversations (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL,
      title       TEXT NOT NULL DEFAULT 'New chat',
      model       TEXT NOT NULL DEFAULT 'ChatBot AI',
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
    );
    INSERT INTO conversations (id, owner_id, title) VALUES ('old-1', 'someone', 'From before');
  `);
  old.close();
}

process.env.DATABASE_PATH = dbPath;
process.env.AI_PROVIDER = 'mock';

const { CookieJar: Jar, createTestServer } = await import('./helpers.ts');

let server: TestServer;
let jar: CookieJar;

before(async () => {
  server = await createTestServer();
  jar = new Jar({ baseUrl: server.baseUrl });
});

after(async () => {
  await server.close();
});

describe('schema upgrade', () => {
  test('an older database gains system_prompt and keeps its rows', async () => {
    const db = new DatabaseSync(dbPath);
    const columns = (db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[])
      .map((c) => c.name);
    assert.ok(columns.includes('system_prompt'));

    const old = db.prepare("SELECT * FROM conversations WHERE id = 'old-1'").get() as ConversationRow;
    assert.equal(old.title, 'From before');
    assert.equal(old.system_prompt, null);
    db.close();

    // And the app can write the new column on this database.
    const res = await jar.post('/api/conversations', { personality: 'concise' });
    assert.equal(res.status, 201);
    const { conversation } = (await res.json()) as { conversation: ConversationRow };
    assert.equal(typeof conversation.system_prompt, 'string');
  });
});
