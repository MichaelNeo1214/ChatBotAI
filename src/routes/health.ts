import { Router } from 'express';
import { config } from '../config.ts';
import { DEFAULT_MODEL_LABEL } from '../providers/presets.ts';
import { provider } from '../providers/index.ts';

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
    uptimeSeconds: Math.round(process.uptime()),
  });
});