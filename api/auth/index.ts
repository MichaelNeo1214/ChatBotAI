/**
 * Authentication — Vercel Serverless Function.
 *
 * Handles the same contract the Express build serves from src/routes/auth.ts,
 * because the frontend calls these unconditionally:
 *
 *   POST   /api/auth/signup      { email, password, name }
 *   POST   /api/auth/login       { email, password }
 *   GET    /api/auth/me
 *   POST   /api/auth/logout
 *   POST   /api/auth/logout-all
 *   DELETE /api/auth/account     { confirm: true }
 *
 * ## Why Supabase and not SQLite
 *
 * The Express build stores users and sessions in node:sqlite. A serverless
 * function has no writable filesystem and no state between invocations, so
 * that store cannot work here. Supabase Auth is stateless HTTP plus a hosted
 * database, which is what a serverless runtime needs.
 *
 * ## Why plain fetch and not @supabase/supabase-js
 *
 * The Auth endpoints are ordinary REST calls with two headers. Calling them
 * directly keeps this function dependency-free, so there is nothing to bundle
 * and no client/edge-runtime compatibility question. It also means the
 * endpoint behaves identically on every Vercel runtime.
 *
 * ## When Supabase is not configured
 *
 * Every route answers 503 { code: "auth_unavailable" } rather than 404 or a
 * crash. A 404 is indistinguishable from a deployment mistake and produces
 * console noise on every page load; a named 503 lets the frontend detect the
 * capability once and stop asking. GET /api/health reports the same fact.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

type Req = IncomingMessage & { body?: unknown };
type Res = ServerResponse;

const SESSION_COOKIE = 'cbai_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_NAME_LENGTH = 80;
const MAX_BODY_BYTES = 16 * 1024;

/** Supabase's GoTrue requires a project URL and an API key. */
function supabaseConfig(): { url: string; anonKey: string; serviceKey: string } | null {
  const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (url === '' || anonKey === '') return null;
  return { url, anonKey, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '' };
}

const isConfigured = (): boolean => supabaseConfig() !== null;

// ---- HTTP plumbing --------------------------------------------------------

function sendJson(res: Res, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(body));
}

const fail = (res: Res, status: number, code: string, message: string, extra?: Record<string, unknown>) =>
  sendJson(res, status, { error: { status, code, message, ...(extra ?? {}) } });

function readBody(req: Req): Promise<Record<string, unknown>> {
  const pre = req.body;
  if (pre !== undefined && pre !== null) {
    if (typeof pre === 'object') return Promise.resolve(pre as Record<string, unknown>);
    if (typeof pre === 'string') {
      try {
        return Promise.resolve(JSON.parse(pre) as Record<string, unknown>);
      } catch {
        return Promise.resolve({});
      }
    }
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (): void => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') return resolve({});
      try {
        const parsed: unknown = JSON.parse(text);
        resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    };

    const stream = req as unknown as Readable;
    if (typeof stream.on !== 'function') return finish();

    stream.on('data', (chunk: Buffer | Uint8Array | string) => {
      size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      // A body past the cap is refused rather than buffered: this endpoint
      // only ever needs an email and a password.
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        stream.destroy();
        return finish();
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    });
    stream.on('end', finish);
    stream.on('error', finish);
    stream.on('close', finish);
  });
}

function cookiesOf(req: Req): Record<string, string> {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return {};

  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key !== '') out[key] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return out;
}

/** The session token the browser holds. */
function sessionToken(req: Req): string | undefined {
  return cookiesOf(req)[SESSION_COOKIE];
}

function setSessionCookie(res: Res, token: string, secure: boolean): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; ` +
      `Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`,
  );
}

function clearSessionCookie(res: Res): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

// ---- Supabase Auth -------------------------------------------------------

interface GoTrueUser {
  id: string;
  email?: string;
  user_metadata?: { name?: string; full_name?: string };
}

/** Normalises a GoTrue user to the shape the frontend already consumes. */
function toPublicUser(user: GoTrueUser): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email ?? '',
    name: user.user_metadata?.name ?? user.user_metadata?.full_name ?? (user.email ?? '').split('@')[0] ?? 'User',
  };
}

async function gotrue(
  config: { url: string; anonKey: string },
  path: string,
  init: { method: string; body?: unknown; token?: string; useServiceKey?: boolean },
): Promise<{ status: number; data: unknown }> {
  const key = init.useServiceKey && config.anonKey ? config.anonKey : config.anonKey;
  const headers: Record<string, string> = {
    apikey: key,
    'Content-Type': 'application/json',
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;

  let response: Response;
  try {
    response = await fetch(`${config.url}/auth/v1${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (error) {
    // A network fault talking to Supabase is a 502, never a 500 with a stack
    // trace leaking upstream URLs.
    return { status: 502, data: { message: 'Could not reach the authentication service.' } };
  }

  const text = await response.text();
  let data: unknown = {};
  if (text !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text.slice(0, 300) };
    }
  }
  return { status: response.status, data };
}

function messageFrom(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.msg === 'string' && record.msg !== '') return record.msg;
    if (typeof record.message === 'string' && record.message !== '') return record.message;
    if (typeof record.error_description === 'string') return record.error_description;
    if (typeof record.error === 'string') return record.error;
  }
  return fallback;
}

// ---- Handlers ------------------------------------------------------------

async function signup(res: Res, body: Record<string, unknown>, secure: boolean): Promise<void> {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME_LENGTH) : '';

  if (!EMAIL_RE.test(email)) return fail(res, 400, 'invalid_email', 'Enter a valid email address.');
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(res, 400, 'weak_password', `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (name === '') return fail(res, 400, 'missing_name', 'Enter a name.');

  const config = supabaseConfig()!;
  const { status, data } = await gotrue(config, '/signup', {
    method: 'POST',
    body: { email, password, data: { name } },
  });

  if (status >= 400) {
    return fail(res, status === 422 ? 400 : status, 'signup_failed', messageFrom(data, 'Could not create that account.'));
  }

  const result = data as { access_token?: string; user?: GoTrueUser };
  // Email confirmation is usually on, in which case there is no session yet
  // and the honest answer is "check your inbox", not a fake logged-in state.
  if (typeof result.access_token !== 'string' || !result.user) {
    return sendJson(res, 200, {
      user: null,
      message: 'Account created. Check your email to confirm the address, then sign in.',
      confirmationRequired: true,
    });
  }

  setSessionCookie(res, result.access_token, secure);
  sendJson(res, 201, { user: toPublicUser(result.user) });
}

async function login(res: Res, body: Record<string, unknown>, secure: boolean): Promise<void> {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!EMAIL_RE.test(email)) return fail(res, 400, 'invalid_email', 'Enter a valid email address.');
  if (password === '') return fail(res, 400, 'missing_password', 'Enter your password.');

  const config = supabaseConfig()!;
  const { status, data } = await gotrue(config, '/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });

  if (status >= 400) {
    // One message for "no such account" and "wrong password" alike, so the
    // response cannot be used to enumerate registered addresses.
    return fail(res, 401, 'invalid_credentials', 'Incorrect email or password.');
  }

  const result = data as { access_token?: string; user?: GoTrueUser };
  if (typeof result.access_token !== 'string' || !result.user) {
    return fail(res, 502, 'auth_failed', 'The authentication service returned an unexpected response.');
  }

  setSessionCookie(res, result.access_token, secure);
  sendJson(res, 200, { user: toPublicUser(result.user) });
}

async function me(res: Res, req: Req): Promise<void> {
  const token = sessionToken(req);
  // Absent token is a normal anonymous visit, not an error.
  if (!token) return sendJson(res, 200, { user: null });

  const config = supabaseConfig()!;
  const { status, data } = await gotrue(config, '/user', { method: 'GET', token });

  if (status >= 400) {
    // The token expired or was revoked; drop the cookie so the next load is
    // clean instead of retrying a dead token forever.
    clearSessionCookie(res);
    return sendJson(res, 200, { user: null });
  }

  sendJson(res, 200, { user: toPublicUser(data as GoTrueUser) });
}

async function logout(res: Res, req: Req): Promise<void> {
  const token = sessionToken(req);
  clearSessionCookie(res);

  if (token) {
    const config = supabaseConfig()!;
    // Best effort: the local session is gone either way, so a failure here
    // must not stop the response.
    await gotrue(config, '/logout', { method: 'POST', token });
  }
  res.statusCode = 204;
  res.end();
}

async function logoutAll(res: Res, req: Req): Promise<void> {
  const token = sessionToken(req);
  clearSessionCookie(res);

  if (token) {
    const config = supabaseConfig()!;
    // Revoking every session needs the service key; without it the local
    // cookie is cleared and the other sessions stay valid.
    if (config.serviceKey !== '') {
      await gotrue({ url: config.url, anonKey: config.serviceKey }, '/logout', {
        method: 'POST',
        token,
        useServiceKey: true,
      });
    }
  }
  res.statusCode = 204;
  res.end();
}

async function deleteAccount(res: Res, req: Req): Promise<void> {
  const body = await readBody(req);
  if (body.confirm !== true) {
    return fail(res, 400, 'confirmation_required', 'Send { "confirm": true } to delete the account.');
  }

  const token = sessionToken(req);
  if (!token) return fail(res, 401, 'sign_in_required', 'Sign in to delete your account.');

  const config = supabaseConfig()!;
  if (config.serviceKey === '') {
    return fail(
      res,
      501,
      'service_role_required',
      'Deleting an account needs SUPABASE_SERVICE_ROLE_KEY on the deployment.',
    );
  }

  const { status, data } = await gotrue(config, '/user', { method: 'GET', token });
  if (status >= 400 || !(data as GoTrueUser)?.id) {
    return fail(res, 401, 'invalid_session', 'Your session has expired. Sign in again.');
  }

  const deleted = await fetch(`${config.url}/auth/v1/admin/users/${(data as GoTrueUser).id}`, {
    method: 'DELETE',
    headers: { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}` },
  });

  if (!deleted.ok) {
    return fail(res, 502, 'delete_failed', 'Could not delete the account.');
  }

  clearSessionCookie(res);
  res.statusCode = 204;
  res.end();
}

// ---- Router --------------------------------------------------------------

/**
 * Resolves which auth action a request is for.
 *
 * Vercel routes a request by the FILE it lands on, so `/api/auth/me` is served
 * by `api/auth/me.ts`, not by `api/auth/index.ts`. Every subpath handler
 * therefore delegates here with its own path.
 *
 * The path is matched on its segments after `auth`, so this tolerates all three
 * shapes a runtime may present: the full `/api/auth/me`, a rewritten `/me`, or
 * the bare `/api/auth`.
 */
function routeOf(req: Req): { action: string; method: string } {
  const raw = req.url ?? '/api/auth';
  const withoutQuery = raw.split('?')[0]!;
  const segments = withoutQuery.split('/').filter(Boolean);

  const authIndex = segments.indexOf('auth');
  const rest = authIndex === -1 ? segments : segments.slice(authIndex + 1);

  return {
    // Nested action names are joined so "logout-all" survives a path split.
    action: rest.join('/'),
    method: (req.method ?? 'GET').toUpperCase(),
  };
}

export default async function handler(req: Req, res: Res): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    res.end();
    return;
  }

  const { action } = routeOf(req);
  // Behind a proxy, X-Forwarded-Proto is what distinguishes HTTPS.
  const forwarded = req.headers['x-forwarded-proto'];
  const secure =
    typeof forwarded === 'string' ? forwarded.split(',')[0]!.trim() === 'https' : process.env.NODE_ENV === 'production';

  if (!isConfigured()) {
    return fail(
      res,
      503,
      'auth_unavailable',
      'Accounts are not enabled on this deployment. Set SUPABASE_URL and SUPABASE_ANON_KEY to turn them on.',
    );
  }

  try {
    switch (`${method} ${action}`) {
      case 'POST signup':
        return await signup(res, await readBody(req), secure);
      case 'POST login':
        return await login(res, await readBody(req), secure);
      case 'GET me':
      case 'GET ':
        return await me(res, req);
      case 'POST logout':
        return await logout(res, req);
      case 'POST logout-all':
        return await logoutAll(res, req);
      case 'DELETE account':
        return await deleteAccount(res, req);
      default:
        res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
        return fail(res, 405, 'method_not_allowed', `No route for ${method} /api/auth/${action}.`);
    }
  } catch (error) {
    console.error('[api/auth]', error);
    return fail(res, 500, 'internal_error', 'Internal server error');
  }
}
