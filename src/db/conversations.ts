import { randomUUID } from 'node:crypto';
import { db, type ConversationRow, type MessageRow } from './index.ts';

const MAX_TITLE_LENGTH = 60;

/**
 * Millisecond-resolution UTC timestamp, matching the column defaults in
 * schema.sql. datetime('now') is only accurate to the second, which let rows
 * written in the same second tie on updated_at and sort arbitrarily.
 */
const NOW_MS = `strftime('%Y-%m-%d %H:%M:%f', 'now')`;

const statements = {
  insertConversation: db.prepare(
    `INSERT INTO conversations (id, owner_id, title, model, system_prompt)
     VALUES (?, ?, ?, ?, ?)`,
  ),
  listConversations: db.prepare(
    `SELECT * FROM conversations WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ?`,
  ),
  getConversation: db.prepare(
    `SELECT * FROM conversations WHERE id = ? AND owner_id = ?`,
  ),
  renameConversation: db.prepare(
    `UPDATE conversations SET title = ?, updated_at = ${NOW_MS} WHERE id = ? AND owner_id = ?`,
  ),
  setSystemPrompt: db.prepare(
    `UPDATE conversations SET system_prompt = ?, updated_at = ${NOW_MS}
     WHERE id = ? AND owner_id = ?`,
  ),
  touchConversation: db.prepare(
    `UPDATE conversations SET updated_at = ${NOW_MS} WHERE id = ?`,
  ),
  deleteConversation: db.prepare(
    `DELETE FROM conversations WHERE id = ? AND owner_id = ?`,
  ),
  insertMessage: db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)`,
  ),
  deleteMessage: db.prepare(
    `DELETE FROM messages WHERE id = ? AND conversation_id = ?`,
  ),
  listMessages: db.prepare(
    `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`,
  ),
};

/** Derives a sidebar title from the first thing the user said. */
export function titleFromMessage(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned === '') return 'New chat';
  return cleaned.length <= MAX_TITLE_LENGTH
    ? cleaned
    : `${cleaned.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

export function createConversation(
  ownerId: string,
  options: { title?: string; model?: string; systemPrompt?: string | null } = {},
): ConversationRow {
  const id = randomUUID();
  statements.insertConversation.run(
    id,
    ownerId,
    options.title ?? 'New chat',
    options.model ?? 'ChatBot AI',
    options.systemPrompt ?? null,
  );
  const created = getConversation(id, ownerId);
  if (!created) throw new Error(`Conversation ${id} vanished immediately after insert`);
  return created;
}

export function listConversations(ownerId: string, limit = 50): ConversationRow[] {
  return statements.listConversations.all(ownerId, limit) as unknown as ConversationRow[];
}

export function getConversation(id: string, ownerId: string): ConversationRow | undefined {
  return statements.getConversation.get(id, ownerId) as unknown as
    | ConversationRow
    | undefined;
}

export function renameConversation(id: string, ownerId: string, title: string): boolean {
  return statements.renameConversation.run(title, id, ownerId).changes > 0;
}

/** `null` clears the prompt so the adapter's default applies again. */
export function setSystemPrompt(
  id: string,
  ownerId: string,
  systemPrompt: string | null,
): boolean {
  return statements.setSystemPrompt.run(systemPrompt, id, ownerId).changes > 0;
}

export function deleteConversation(id: string, ownerId: string): boolean {
  return statements.deleteConversation.run(id, ownerId).changes > 0;
}

export function listMessages(conversationId: string): MessageRow[] {
  return statements.listMessages.all(conversationId) as unknown as MessageRow[];
}

/** Scoped to the conversation so an id from another thread cannot match. */
export function deleteMessage(conversationId: string, messageId: string): boolean {
  const removed = statements.deleteMessage.run(messageId, conversationId).changes > 0;
  if (removed) statements.touchConversation.run(conversationId);
  return removed;
}

export function addMessage(
  conversationId: string,
  role: MessageRow['role'],
  content: string,
): MessageRow {
  const id = randomUUID();
  statements.insertMessage.run(id, conversationId, role, content);
  statements.touchConversation.run(conversationId);
  return {
    id,
    conversation_id: conversationId,
    role,
    content,
    created_at: new Date().toISOString(),
  };
}
