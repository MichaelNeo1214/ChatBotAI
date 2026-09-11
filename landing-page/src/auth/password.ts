import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Hashes with scrypt from node:crypto — no native dependency to compile, and
 * memory-hard, unlike a bare SHA. Format: scrypt$<salt hex>$<key hex>.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const derived = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);

  // Constant-time: never short-circuit on the first differing byte.
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

/**
 * A throwaway hash verified when no user matches, so a missing account costs
 * the same time as a wrong password and cannot be detected by timing.
 */
export const DUMMY_HASH = await hashPassword(randomBytes(32).toString('hex'));
