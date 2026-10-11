import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The SQLite handle, opened on first use rather than at import time.
 *
 * This used to run `mkdirSync` + `new DatabaseSync()` as a module side effect,
 * which made merely *importing* this file touch the filesystem. That matters
 * because the Vercel functions in api/ import from src/ for the provider layer,
 * and their filesystem is read-only: one stray import reaching this module
 * would fail the whole function with a SQLite open error at import time, with
 * nothing in the stack trace pointing at the real cause.
 *
 * Deferring the open means the module is safe to import anywhere, and only
 * genuinely local (Express) usage ever touches disk. test/no-serverless-db.test.ts
 * asserts the api/ import graph still does not reach this file.
 */
let handle: DatabaseSync | undefined;

function open(): DatabaseSync {
  if (handle !== undefined) return handle;

  mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const database = new DatabaseSync(config.databasePath);

  // Schema is idempotent, so running it on every open is the migration story
  // until the project needs versioned migrations.
  database.exec(readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));

  handle = database;
  return handle;
}

/** The live database handle. Throws if the path cannot be opened. */
export function getDb(): DatabaseSync {
  return open();
}

/** Closes the handle if it was ever opened. Safe to call when it was not. */
export function closeDb(): void {
  if (handle === undefined) return;
  try {
    handle.close();
  } finally {
    handle = undefined;
  }
}

/**
 * Drop-in lazy stand-in for the handle itself.
 *
 * Kept so the existing `db.prepare(...)` call sites in conversations.ts and
 * users.ts keep working unchanged; methods are bound to the real handle so
 * `this` is correct inside node:sqlite.
 */
export const db: DatabaseSync = new Proxy({} as DatabaseSync, {
  get(_target, property) {
    const real = open() as unknown as Record<string | symbol, unknown>;
    const value = real[property];
    return typeof value === 'function' ? value.bind(real) : value;
  },
  has(_target, property) {
    return property in (open() as unknown as object);
  },
});

export interface ConversationRow {
  id: string;
  owner_id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}
