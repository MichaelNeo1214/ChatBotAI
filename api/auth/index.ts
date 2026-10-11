/**
 * Authentication â€” Vercel Serverless Function.
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
 * ## Why the SDK and not raw REST
 *
 * Auth goes through @supabase/supabase-js. The client is constructed with
 * persistence and token refresh switched off, because a serverless invocation
 * has neither: a client that tries to persist a session has nowhere to write
 * it, and an auto-refresh timer outlives the invocation and gets the function
 * killed by the platform.
 *
 * Two operations have no SDK equivalent and still use fetch directly: the
 * Admin delete-user call, and anything that must carry the service-role header.
 *
 * ## There is no local database here
 *
 * The Express build in src/ keeps users in node:sqlite. A serverless function
 * has no writable filesystem and no state between invocations, so nothing in
 * api/ reads or writes one â€” the handler holds no storage of any kind.
 *
 * ## When Supabase is not configured
 *
 * Every route answers 503 { code: "auth_unavailable" } rather than 404 or a
 * crash. A 404 is indistinguishable from a deployment mistake and produces
 * console noise on every page load; a named 503 lets the frontend detect the
 * capability once and stop asking. GET /api/health reports the same fact.
 *
 * Note that this path makes NO outgoing request at all, which is how a missing
 * env var is told apart from a stalled upstream in the platform logs.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cleanSupabaseKey, cleanSupabaseUrl } from '../../src/supabase-url.ts';

type Req = IncomingMessage & { body?: unknown };
type Res = ServerResponse;

const SESSION_COOKIE = 'cbai_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_NAME_LENGTH = 80;
const MAX_BODY_BYTES = 16 * 1024;
/**
 * How long to wait for a request body before answering anyway.
 *
 * Every path out of readBody must settle. A handler that never responds is
 * reported by the platform as a 502, which points at the infrastructure
 * instead of at the real problem.
 */
const BODY_READ_TIMEOUT_MS = 3_000;
/**
 * Ceiling on a single call to Supabase Auth.
 *
 * Must stay well under this function's maxDuration (15s in vercel.json) so the
 * handler always gets to write its own response. A platform-level kill is
 * indistinguishable from a broken deployment to the caller.
 */
const UPSTREAM_TIMEOUT_MS = 8_000;

/** Strips stray quotes/whitespace from a pasted key. */

/** Supabase's GoTrue requires a project URL and an API key. */
function supabaseConfig(): { url: string; anonKey: string; serviceKey: string } | null {
  const url = cleanSupabaseUrl(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '');
  const anonKey = cleanSupabaseKey(
    process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
  if (url === '' || anonKey === '') return null;
  return { url, anonKey, serviceKey: cleanSupabaseKey(process.env.SUPABASE_SERVICE_ROLE_KEY) };
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
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);

      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') return resolve({});
      try {
        const parsed: unknown = JSON.parse(text);
        resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    };

    const stream = req as unknown as Readable & { readableEnded?: boolean; destroyed?: boolean };
    if (typeof stream.on !== 'function') return finish();

    // A stream that has already ended will never emit 'end' again. Without
    // this check the promise below never settles, the handler never responds,
    // and the platform reports a gateway error rather than the 400 this
    // actually is. Runtimes that pre-parse the body hit this path.
    if (stream.readableEnded === true || stream.destroyed === true) return finish();

    // Backstop: never leave the function waiting on a socket that goes quiet.
    timer = setTimeout(finish, BODY_READ_TIMEOUT_MS);

    stream.on('data', (chunk: Buffer | Uint8Array | string) => {
      if (settled) return;
      size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;

      if (size > MAX_BODY_BYTES) {
        // Stop accumulating and answer now. The stream is deliberately NOT
        // destroyed: tearing down the request mid-flight can stop the response
        // from being written at all, which surfaces as a 502 rather than a 413.
        chunks.length = 0;
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
      if (key === '') continue;

      const raw = part.slice(separator + 1).trim();
      // decodeURIComponent throws on a stray '%' that is not a valid escape.
      // A cookie header is attacker-controlled, so this must never throw out of
      // a parser: an undecodable value is simply treated as literal.
      let value = raw;
      try {
        value = decodeURIComponent(raw);
      } catch {
        value = raw;
      }
      out[key] = value;
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

/**
 * Builds a Supabase client for a single call.
 *
 * `persistSession: false` and `autoRefreshToken: false` are required, not
 * cosmetic: a serverless invocation has no long-lived storage and no refresh
 * cycle, and a client that tries to persist would either throw or start a
 * timer that keeps the function alive past its invocation.
 *
 * `auth: { persistSession: false }` also keeps the import free of any browser
 * global, which is what makes this safe under every Vercel runtime.
 */
function supabaseClient(key?: string): SupabaseClient {
  const config = supabaseConfig();
  if (config === null) {
    // Callers gate on isConfigured() before reaching here; this keeps the
    // failure legible rather than handing the SDK an empty URL.
    throw new Error('Supabase is not configured on this deployment.');
  }

  return createClient(config.url, key ? cleanSupabaseKey(key) : config.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      // Every call is bounded so a stalled upstream can never outlive this
      // function's maxDuration and get the invocation killed by the platform.
      fetch: (input: string | URL | Request, init: RequestInit = {}) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }),
    },
  });
}

/** Shape returned by supabase-js so the callers read naturally. */
interface AuthOutcome {
  ok: boolean;
  status: number;
  data: unknown;
  message: string;
}

async function signupWithSupabase(
  email: string,
  password: string,
  name: string,
): Promise<{ user: GoTrueUser | null; accessToken: string | null; message: string }> {
  const supabase = supabaseClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    // Supabase reserves `email` and `phone` in user_metadata; the rest are
    // free-form and land on the JWT the client can read back.
    options: { data: { name, full_name: name } },
  });

  if (error) {
    return { user: null, accessToken: null, message: messageFrom({ message: error.message }, 'Could not create that account.') };
  }
  return {
    user: (data?.user as GoTrueUser) ?? null,
    accessToken: data?.session?.access_token ?? null,
    message: '',
  };
}

async function signInWithSupabase(
  email: string,
  password: string,
): Promise<{ user: GoTrueUser | null; accessToken: string | null; error: string }> {
  const supabase = supabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // One message for "no such account" and "wrong password" alike, so the
    // response cannot be used to enumerate registered addresses.
    return { user: null, accessToken: null, error: 'Incorrect email or password.' };
  }
  return {
    user: (data?.user as GoTrueUser) ?? null,
    accessToken: data?.session?.access_token ?? null,
    error: '',
  };
}

async function userFromToken(token: string): Promise<GoTrueUser | null> {
  const supabase = supabaseClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error) return null;
  return (data?.user as GoTrueUser) ?? null;
}

/**
 * Signs a user out everywhere.
 *
 * supabase-js's own signOut() needs a client-side session, which a serverless
 * invocation never has, so this calls the Admin API directly with the service
 * key. With only the anon key there is nothing to revoke server-side, and the
 * caller still clears the local cookie.
 */
async function revokeToken(token: string): Promise<void> {
  const serviceKey = cleanSupabaseKey(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (serviceKey === '') return;
  try {
    const supabase = supabaseClient(serviceKey);
    await supabase.auth.admin.signOut(token);
  } catch (e) {
    // Best effort: the local cookie is cleared by the caller regardless.
  }
}

/**
 * Admin-only calls that supabase-js does not wrap (deleting a user).
 *
 * Kept on plain fetch because the Admin API needs the service role header and
 * supabase-js exposes no equivalent for this operation.
 */
async function adminDeleteUser(userId: string): Promise<boolean> {
  const config = supabaseConfig()!;
  const url = config.url;
  const serviceKey = config.serviceKey;
  if (url === '' || serviceKey === '') return false;

  try {
    const response = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return response.ok;
  } catch (e) {
    return false;
  }
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

  // Straight to Supabase. Nothing is written anywhere local: this function has
  // no database, no filesystem and no state between invocations.
  const result = await signupWithSupabase(email, password, name);

  if (result.message !== '') {
    return fail(res, 400, 'signup_failed', result.message);
  }

  // Email confirmation is usually enabled, in which case there is no session
  // yet. Saying "check your inbox" is honest; faking a logged-in state is not.
  if (result.user === null || result.accessToken === null) {
    return sendJson(res, 200, {
      user: null,
      message: 'Account created. Check your email to confirm the address, then sign in.',
      confirmationRequired: true,
    });
  }

  setSessionCookie(res, result.accessToken, secure);
  sendJson(res, 201, { user: toPublicUser(result.user) });
}

async function login(res: Res, body: Record<string, unknown>, secure: boolean): Promise<void> {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!EMAIL_RE.test(email)) return fail(res, 400, 'invalid_email', 'Enter a valid email address.');
  if (password === '') return fail(res, 400, 'missing_password', 'Enter your password.');

  const result = await signInWithSupabase(email, password);

  if (result.error !== '') {
    // One message for "no such account" and "wrong password" alike, so the
    // response cannot be used to enumerate registered addresses.
    return fail(res, 401, 'invalid_credentials', result.error);
  }
  if (result.user === null || result.accessToken === null) {
    return fail(res, 503, 'auth_failed', 'The authentication service returned an unexpected response.');
  }

  setSessionCookie(res, result.accessToken, secure);
  sendJson(res, 200, { user: toPublicUser(result.user) });
}

async function me(res: Res, req: Req): Promise<void> {
  const token = sessionToken(req);
  // An absent token is a normal anonymous visit, not an error.
  if (!token) return sendJson(res, 200, { user: null });

  const user = await userFromToken(token);
  if (user === null) {
    // Expired or revoked: drop the cookie so the next load starts clean
    // instead of retrying a dead token forever.
    clearSessionCookie(res);
    return sendJson(res, 200, { user: null });
  }

  sendJson(res, 200, { user: toPublicUser(user) });
}

async function logout(res: Res, req: Req): Promise<void> {
  const token = sessionToken(req);
  clearSessionCookie(res);
  // Best effort: the local session is gone either way, so a failure here must
  // not stop the response.
  if (token) await revokeToken(token);
  res.statusCode = 204;
  res.end();
}

async function logoutAll(res: Res, req: Req): Promise<void> {
  await logout(res, req);
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

  const user = await userFromToken(token);
  if (user === null) {
    return fail(res, 401, 'invalid_session', 'Your session has expired. Sign in again.');
  }

  if (!(await adminDeleteUser(user.id))) {
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
