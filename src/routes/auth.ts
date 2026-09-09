import { Router } from 'express';
import { clearSessionCookie, readCookie, setSessionCookie, SESSION_COOKIE } from '../auth/cookies.ts';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../auth/password.ts';
import { rateLimit } from '../auth/rate-limit.ts';
import {
  claimConversations,
  createSession,
  createUser,
  destroySession,
  findUserByEmail,
  findUserById,
  normalizeEmail,
  toPublicUser,
} from '../db/users.ts';
import { badRequest, HttpError } from '../middleware/errors.ts';

export const authRouter = Router();

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;

// Deliberately permissive: the point is to catch typos, not to adjudicate the
// RFC. Real verification is an emailed link, which this project does not send yet.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Scoped by IP and email so one attacker cannot lock out an entire office NAT. */
const attemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) => `${req.ip ?? 'unknown'}:${normalizeEmail(String(req.body?.email ?? ''))}`,
});

function readCredentials(body: unknown): { email: string; password: string } {
  const { email, password } = (body ?? {}) as Record<string, unknown>;

  if (typeof email !== 'string' || email.trim() === '') {
    throw badRequest('Email is required');
  }
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email.trim())) {
    throw badRequest('Enter a valid email address');
  }
  if (typeof password !== 'string' || password === '') {
    throw badRequest('Password is required');
  }
  return { email: email.trim(), password };
}

authRouter.post('/signup', attemptLimiter, async (req, res, next) => {
  try {
    const { email, password } = readCredentials(req.body);
    const { name } = (req.body ?? {}) as Record<string, unknown>;

    if (typeof name !== 'string' || name.trim() === '') {
      throw badRequest('Name is required');
    }
    if (name.trim().length > MAX_NAME_LENGTH) {
      throw badRequest(`Name must be at most ${MAX_NAME_LENGTH} characters`);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw badRequest(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
    }
    if (findUserByEmail(email)) {
      throw new HttpError(409, 'An account with that email already exists');
    }

    const user = createUser({
      email,
      name: name.trim(),
      passwordHash: await hashPassword(password),
    });

    // Carry over whatever this browser chatted about before signing up.
    const claimed = claimConversations(req.anonymousId, user.id);

    const { token } = createSession(user.id);
    setSessionCookie(res, token);

    res.status(201).json({ user: toPublicUser(user), claimedConversations: claimed });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/login', attemptLimiter, async (req, res, next) => {
  try {
    const { email, password } = readCredentials(req.body);
    const user = findUserByEmail(email);

    // Verify against a dummy hash when the account is missing, so response time
    // does not reveal whether the email is registered.
    const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);

    if (!user || !valid) {
      throw new HttpError(401, 'Incorrect email or password');
    }

    const { token } = createSession(user.id);
    setSessionCookie(res, token);

    res.json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/logout', (req, res) => {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (token) destroySession(token);
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.get('/me', (req, res) => {
  if (!req.userId) {
    res.json({ user: null });
    return;
  }
  const user = findUserById(req.userId);
  res.json({ user: user ? toPublicUser(user) : null });
});
