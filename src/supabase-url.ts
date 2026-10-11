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

  let url = String(rawUrl).replace(/['"]/g, '').trim();
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

  return url;
}

/** Strips stray quotes and whitespace from a pasted key. */
export function cleanSupabaseKey(rawKey?: string | null): string {
  if (rawKey === undefined || rawKey === null) return '';
  return String(rawKey).replace(/['"]/g, '').trim();
}

/**
 * True when a Supabase project URL and key are both present and usable.
 *
 * `publicAnonKey` reports whether an unauthenticated caller could be trusted
 * with it; the health endpoint exposes only the boolean, never the key.
 */
export function supabaseIsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const url = cleanSupabaseUrl(env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? '');
  const key = cleanSupabaseKey(
    env.SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY,
  );
  return url !== '' && key !== '';
}