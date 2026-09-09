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
