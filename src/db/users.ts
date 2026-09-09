import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { db } from './index.ts';

export interface UserRow {
  id: string;
  email: string;
  email_key: string;
  name: string;
  password_hash: string;
  created_at: string;
}

/** A user without the password hash — safe to send to a client. */
export type PublicUser = Pick<UserRow, 'id' | 'email' | 'name' | 'created_at'>;

export const SESSION_TTL_DAYS = 30;

const statements = {
  insertUser: db.prepare(
    `INSERT INTO users (id, email, email_key, name, password_hash) VALUES (?, ?, ?, ?, ?)`,
  ),
  findByEmailKey: db.prepare(`SELECT * FROM users WHERE email_key = ?`),
  findById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  insertSession: db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
  ),
  findSession: db.prepare(
    `SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')`,
  ),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
  deleteExpired: db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`),
  claimConversations: db.prepare(
    `UPDATE conversations SET owner_id = ? WHERE owner_id = ?`,
  ),
};

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const toPublicUser = (user: UserRow): PublicUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  created_at: user.created_at,
});

export function findUserByEmail(email: string): UserRow | undefined {
  return statements.findByEmailKey.get(normalizeEmail(email)) as unknown as
    | UserRow
    | undefined;
}

export function findUserById(id: string): UserRow | undefined {
  return statements.findById.get(id) as unknown as UserRow | undefined;
}

export function createUser(input: {
  email: string;
  name: string;
  passwordHash: string;
}): UserRow {
  const id = randomUUID();
  statements.insertUser.run(
    id,
    input.email.trim(),
    normalizeEmail(input.email),
    input.name.trim(),
    input.passwordHash,
  );
  const created = findUserById(id);
  if (!created) throw new Error(`User ${id} vanished immediately after insert`);
  return created;
}

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Creates a session and returns the raw token, which is stored only in the cookie. */
export function createSession(userId: string): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  statements.insertSession.run(
    hashToken(token),
    userId,
    expiresAt.toISOString().replace('T', ' ').slice(0, 19),
  );
  return { token, expiresAt };
}

export function findSessionUserId(token: string): string | undefined {
  const row = statements.findSession.get(hashToken(token)) as unknown as
    | { user_id: string }
    | undefined;
  return row?.user_id;
}

export function destroySession(token: string): void {
  statements.deleteSession.run(hashToken(token));
}

export function purgeExpiredSessions(): number {
  return Number(statements.deleteExpired.run().changes);
}

/**
 * Moves conversations started anonymously in this browser onto the new account,
 * so signing up does not appear to discard the chat you just had.
 */
export function claimConversations(fromOwnerId: string, toUserId: string): number {
  if (fromOwnerId === toUserId) return 0;
  return Number(statements.claimConversations.run(toUserId, fromOwnerId).changes);
}
