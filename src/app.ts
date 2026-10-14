import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { ROOT_DIR, STATIC_FILES, STATIC_MOUNTS, config } from './config.ts';
import { errorHandler, notFoundHandler } from './middleware/errors.ts';
import { identifyOwner } from './middleware/owner.ts';
import { authRouter } from './routes/auth.ts';
import { chatRouter } from './routes/chat.ts';
import { conversationsRouter } from './routes/conversations.ts';
import { healthRouter } from './routes/health.ts';
import { imageRouter } from './routes/image.ts';

/**
 * Headers a browser may send on a cross-origin request.
 *
 * The three X-Provider-* headers carry the caller's bring-your-own-key, so a
 * whitelisted origin is useless without them being allowed here.
 */
const ALLOWED_REQUEST_HEADERS = [
  'Content-Type',
  'X-Provider-Key',
  'X-Provider-Base-Url',
  'X-Provider-Model',
].join(', ');

function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    // The preflight is only answered with CORS headers for allowlisted origins
    // above, so an unknown origin gets a bare 204 that grants it nothing.
    res.sendStatus(204);
    return;
  }
  next();
}

/**
 * Mounts the frontend from an explicit allowlist.
 *
 * The previous implementation served ROOT_DIR, which put data/chatbot.db —
 * every user's password hash, session token hash and stored message — plus
 * src/, test/ and node_modules/ on the open web. Only the handful of paths the
 * browser actually requests are mounted now, so anything added to the repo
 * root later is private unless it is listed in config.STATIC_MOUNTS /
 * config.STATIC_FILES.
 */
/** Sends the app shell for a client-side route. */
function serveShell(_req: Request, res: Response): void {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
}

function serveStatic(app: express.Express): void {
  for (const mount of STATIC_MOUNTS) {
    app.use(`/${mount}`, express.static(path.join(ROOT_DIR, mount), { index: false }));
  }

  for (const file of STATIC_FILES) {
    app.get(`/${file}`, (_req: Request, res: Response) => {
      res.sendFile(path.join(ROOT_DIR, file), (err?: Error) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    });
  }

  // The app shell. SPA-style extension resolution is intentionally NOT enabled:
  // a request for "/src/app" must 404, not silently return index.html.
  app.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(ROOT_DIR, 'index.html'));
  });
  app.get('/index.html', (_req: Request, res: Response) => {
    res.sendFile(path.join(ROOT_DIR, 'index.html'));
  });

  // Client-side routes. These must resolve to the shell on a hard load, not
  // 404 — the whole point of /c/:id and /share/:shareId is that they can be
  // pasted into another browser. vercel.json declares the same rewrites for the
  // deployed build, so both environments behave identically.
  app.get('/c/:id', serveShell);
  app.get('/share/:shareId', serveShell);

  // Anything left is a miss, including every path inside the allowlist that
  // does not exist. Answering here keeps Express from falling through to the
  // error handler with a stack trace.
  app.use(notFoundHandler);
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Security headers. Vercel sets these via vercel.json, but this server is
  // also run directly, and without them it is trivially framable, sniffable
  // and script-injectable. The CSP mirrors the Vercel one: every script on the
  // page is an external file, so no inline source is needed, and connect-src
  // stays broad enough for BYOK providers on any https host.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; " +
        "script-src 'self' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; " +
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; " +
        "font-src 'self' data: https://cdnjs.cloudflare.com; " +
        "img-src 'self' data: blob: https:; " +
        "connect-src 'self' https:; " +
        "worker-src 'self' blob:; " +
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), microphone=(self), interest-cohort=()');
    if (req.secure || String(req.headers['x-forwarded-proto'] ?? '').includes('https')) {
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
    next();
  });

  // Off unless TRUST_PROXY says otherwise — see config.parseTrustProxy for why
  // enabling it blindly would let anyone spoof X-Forwarded-For.
  app.set('trust proxy', config.trustProxy);

  app.use(cors);
  // A chat turn may carry base64 images, so the body ceiling has to match the
  // attachment budget in providers/attachments.ts (~3 MB of base64 plus text).
  // parseAttachments still validates every image; this only stops the parser
  // from rejecting a legitimate oversized-but-valid body before it gets there.
  app.use(express.json({ limit: '6mb' }));

  app.use('/api/health', healthRouter);

  // Everything below is scoped to a caller.
  app.use('/api', identifyOwner);
  app.use('/api/auth', authRouter);
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/image', imageRouter);

  app.use('/api', notFoundHandler);

  serveStatic(app);

  app.use(errorHandler);

  return app;
}