/**
 * GET /api/health — Vercel Serverless Function.
 *
 * Mirrors the Express route of the same name so the frontend behaves
 * identically in both deployments. The UI reads `demo` to decide whether to
 * show the "this server has no AI key configured" banner: with no key the boot
 * provider is the mock, which streams canned replies, and that must never be
 * mistaken for a working free tier.
 *
 * Only non-sensitive state is returned. No key, base URL or path is echoed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../src/config.ts';
import { DEFAULT_MODEL_LABEL } from '../src/providers/presets.ts';
import { isDemoProvider } from '../src/providers/index.ts';

type Req = IncomingMessage;
type Res = ServerResponse;

/**
 * Whether accounts are usable on this deployment.
 *
 * Exposed on /api/health so the frontend can discover it once instead of
 * probing /api/auth/me on every page load and logging a 404 each time.
 */
function isAuthConfigured(): boolean {
  const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  return url !== '' && key !== '';
}

export default function handler(req: Req, res: Res): void {
  if ((req.method ?? 'GET').toUpperCase() === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'GET, OPTIONS');
    res.end();
    return;
  }

  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { status: 405, code: 'method_not_allowed', message: 'Use GET for /api/health.' } }));
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(
    JSON.stringify({
      status: 'ok',
      env: config.env,
      provider: isDemoProvider() ? 'mock' : config.provider.name,
      defaultModel: DEFAULT_MODEL_LABEL,
      demo: isDemoProvider(),
      /** Accounts are optional; the app works as a guest when this is false. */
      auth: isAuthConfigured(),
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );
}