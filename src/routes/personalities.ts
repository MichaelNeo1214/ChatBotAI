import { Router } from 'express';
import { PERSONALITIES } from '../chat/personalities.ts';

export const personalitiesRouter = Router();

/** The built-in personas, for a picker. Static, so it is safe to cache. */
personalitiesRouter.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({ personalities: PERSONALITIES });
});
