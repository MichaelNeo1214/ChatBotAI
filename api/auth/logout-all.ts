/**
 * /api/auth/logout-all — POST — revoke sessions
 *
 * Vercel routes by file path, so this exists as its own entry point. The logic
 * lives in ./index.ts, which is also served at the bare /api/auth route.
 */
import handler from './index.ts';

export default handler;
