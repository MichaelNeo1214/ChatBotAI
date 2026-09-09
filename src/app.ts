import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { ROOT_DIR, config } from './config.ts';
import { errorHandler, notFoundHandler } from './middleware/errors.ts';
import { identifyOwner } from './middleware/owner.ts';
import { authRouter } from './routes/auth.ts';
import { chatRouter } from './routes/chat.ts';
import { conversationsRouter } from './routes/conversations.ts';
import { healthRouter } from './routes/health.ts';

function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors);
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/health', healthRouter);

  // Everything below is scoped to a caller.
  app.use('/api', identifyOwner);
  app.use('/api/auth', authRouter);
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/chat', chatRouter);

  app.use('/api', notFoundHandler);

  // The existing static frontend is served from the repo root.
  app.use(express.static(ROOT_DIR, { index: 'index.html', extensions: ['html'] }));

  app.use(errorHandler);

  return app;
}
