/**
 * Supabase URL normalisation.
 *
 * Kept in its own module so both the auth handlers and the health probe can
 * use it without importing @supabase/supabase-js. /api/health runs on every
 * page load; making it depend on the SDK would pull ~50 KB into a function that
 * only reads two environment variables.
 */

/**
 * Normalises a configured SUPABASE_URL into a project root.
 *
 * The Data API settings panel in the Supabase dashboard shows a URL ending in
 * `/rest/v1`, and that is the value people copy most often. The SDK then
 * appends its own `/auth/v1/...` to it, so the request goes to
 * `/rest/v1/auth/v1/signup` and answers "Invalid path specified in request
 * URL" — a 404 that looks like a routing or permissions fault and is neither.
 *
 * Also tolerates surrounding quotes and a missing scheme, both of which arrive
 * when a value is pasted straight out of a dashboard field.
 */
export function cleanSupabaseUrl(rawUrl?: string | null): string {
  if (rawUrl === undefined || rawUrl === null) return '';

  // Quotes AND newlines: a value pasted from a dashboard field, or written into
  // a .env by a script that echoed it, routinely carries either.
  let url = String(rawUrl).replace(/['"\r\n\t]/g, '').trim();
  if (url === '') return '';

  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  // Trailing slashes are removed FIRST. Doing it afterwards lets a value like
  // ".../rest/v1///" survive the anchored suffix match and leave the Data API
  // path in place, which is the exact failure this function exists to prevent.
  url = url.replace(/\/+$/, '');

  // Anchored at the end so a legitimate sub-path elsewhere is left alone.
  url = url
    .replace(/\/rest\/v1$/i, '')
    .replace(/\/auth\/v1$/i, '')
    .replace(/\/postgres$/i, '')
    .replace(/\/+$/, '');

  // A non-empty string is not a valid URL. createClient() throws
  // "Invalid supabaseUrl: Provided URL is malformed." on anything the parser
  // rejects, so the check has to happen here — otherwise a typo'd variable
  // passes the configuration gate and blows up inside the handler instead of
  // being reported as "accounts not configured".
  try {
    const parsed = new URL(url);
    if (parsed.hostname === '') return '';
    return url;
  } catch {
    return '';
  }
}

/** Strips stray quotes, newlines and whitespace from a pasted key. */
export function cleanSupabaseKey(rawKey?: string | null): string {
  if (rawKey === undefined || rawKey === null) return '';
  return String(rawKey).replace(/['"\r\n\t]/g, '').trim();
}

/**
 * The configured project URL, or null when it is absent or unusable.
 *
 * Preferable to calling cleanSupabaseUrl directly at a call site: an empty
 * string and an unparseable value mean the same thing to the caller, and both
 * must fail before createClient() is reached.
 */
export function getValidSupabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = cleanSupabaseUrl(
    env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? '',
  );
  return url === '' ? null : url;
}

/** The configured anon key, or an empty string when absent. */
export function getSanitizedSupabaseKey(env: NodeJS.ProcessEnv = process.env): string {
  return cleanSupabaseKey(env.SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '');
}

/**
 * True when a Supabase project URL and key are both present and usable.
 *
 * A malformed URL counts as NOT configured on purpose: reporting it honestly
 * makes /api/health answer false, so the frontend shows its "accounts not
 * enabled" hint instead of every login attempt failing with a raw
 * "Invalid supabaseUrl" from deep inside the SDK.
 */
export function supabaseIsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (getValidSupabaseUrl(env) === null) return false;

  // A service-role key alone still lets the SDK sign users in, so it counts as
  // configured. It stays server-only and is never echoed to a client.
  const key = cleanSupabaseKey(
    env.SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY,
  );
  return key !== '';
}