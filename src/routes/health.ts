import { Router } from 'express';
import { config } from '../config.ts';
import { provider } from '../providers/index.ts';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    env: config.env,
    provider: provider.name,
    uptimeSeconds: Math.round(process.uptime()),
  });
});
