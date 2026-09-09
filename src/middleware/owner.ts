import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { isProduction } from '../config.ts';

const COOKIE_NAME = 'cbai_owner';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Who owns the conversations in this request. */
      ownerId: string;
    }
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

/**
 * Assigns each browser a stable anonymous id so conversations are scoped to it.
 * When real auth lands, replace the cookie lookup with the session's user id —
 * everything downstream reads `req.ownerId` and needs no change.
 */
export function identifyOwner(req: Request, res: Response, next: NextFunction): void {
  const existing = readCookie(req.headers.cookie, COOKIE_NAME);

  if (existing && UUID_PATTERN.test(existing)) {
    req.ownerId = existing;
    next();
    return;
  }

  const ownerId = randomUUID();
  req.ownerId = ownerId;
  res.cookie(COOKIE_NAME, ownerId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: ONE_YEAR_SECONDS * 1000,
    path: '/',
  });
  next();
}
