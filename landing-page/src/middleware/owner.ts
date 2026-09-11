import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { OWNER_COOKIE, SESSION_COOKIE, readCookie } from '../auth/cookies.ts';
import { isProduction } from '../config.ts';
import { findSessionUserId } from '../db/users.ts';

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Who owns the conversations in this request: a user id, or an anonymous id. */
      ownerId: string;
      /** Set only when the request carries a valid session. */
      userId?: string;
      /** The anonymous id for this browser, kept even while signed in. */
      anonymousId: string;
    }
  }
}

/**
 * Resolves the identity conversations are scoped to.
 *
 * A valid session wins, so signing in shows that account's history on any
 * browser. Otherwise the caller keeps a per-browser anonymous id, which is what
 * lets someone chat before creating an account.
 */
export function identifyOwner(req: Request, res: Response, next: NextFunction): void {
  // Anonymous id first: signup claims its conversations for the new account.
  const existing = readCookie(req.headers.cookie, OWNER_COOKIE);
  let anonymousId: string;

  if (existing && UUID_PATTERN.test(existing)) {
    anonymousId = existing;
  } else {
    anonymousId = randomUUID();
    res.cookie(OWNER_COOKIE, anonymousId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: ONE_YEAR_MS,
      path: '/',
    });
  }
  req.anonymousId = anonymousId;

  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  const userId = token ? findSessionUserId(token) : undefined;

  if (userId) {
    req.userId = userId;
    req.ownerId = userId;
  } else {
    req.ownerId = anonymousId;
  }

  next();
}

/** Rejects the request unless it carries a valid session. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.userId) {
    res.status(401).json({ error: { message: 'Sign in required', status: 401 } });
    return;
  }
  next();
}
