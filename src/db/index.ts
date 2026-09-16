import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);

// Schema is idempotent, so running it on every boot is the migration story
// until the project needs versioned migrations.
db.exec(readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));

// CREATE TABLE IF NOT EXISTS does nothing for a table that already exists, so
// columns added after a database was first created need their own guarded
// ALTER. Each entry is applied once and is a no-op afterwards.
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'conversations', column: 'system_prompt', definition: 'TEXT' },
];

for (const { table, column, definition } of ADDED_COLUMNS) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!existing.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export interface ConversationRow {
  id: string;
  owner_id: string;
  title: string;
  model: string;
  /** Custom instructions for this conversation; null means the default. */
  system_prompt: string | null;
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
