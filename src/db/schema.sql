PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Conversations are scoped by owner_id. Until real auth lands, that is an
-- anonymous client id carried in a cookie; afterwards it becomes the user id,
-- so no schema change is needed to switch over.
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT 'New chat',
  model       TEXT NOT NULL DEFAULT 'ChatBot AI',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_owner
  ON conversations (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content          TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages (conversation_id, created_at);
