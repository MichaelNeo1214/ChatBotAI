import { Router } from 'express';
import { config } from '../config.ts';
import { DEFAULT_MODEL_LABEL } from '../providers/presets.ts';
import { provider } from '../providers/index.ts';
import { cleanSupabaseKey, cleanSupabaseUrl, supabaseIsConfigured } from '../supabase-url.ts';

export const healthRouter = Router();

/**
 * Liveness plus enough state for the UI to explain itself.
 *
 * `demo` is what the frontend keys its banner off: it is true only when the
 * boot provider is the mock, which streams canned replies. That must never be
 * mistaken for a working free tier, so the UI says so explicitly rather than
 * letting a visitor think a real model is answering.
 */
healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    env: config.env,
    provider: provider.name,
    defaultModel: DEFAULT_MODEL_LABEL,
    demo: provider.name === 'mock',
    /**
     * Accounts. The Express build stores users in SQLite and always has them;
     * the serverless build reports false here unless Supabase is configured.
     */
    auth: true,
    /**
     * Server-side conversation storage. The Express build has it, which is why
     * the frontend is allowed to ask for the list without producing a 404.
     */
    conversations: true,
    /**
     * Browser cloud config. The frontend used to carry a hardcoded
     * placeholder, which made sync silently dead everywhere. The anon key is
     * publishable by design and RLS protects the rows; the service-role key is
     * never included, because it would bypass RLS entirely.
     */
    supabase: supabaseIsConfigured()
      ? {
          url: cleanSupabaseUrl(
            process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
          ),
          anonKey: cleanSupabaseKey(
            process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
          ),
        }
      : null,
    uptimeSeconds: Math.round(process.uptime()),
  });
});