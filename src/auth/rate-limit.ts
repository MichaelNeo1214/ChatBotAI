import type { NextFunction, Request, Response } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * A small fixed-window limiter held in memory. Enough to blunt password
 * guessing on a single instance; a multi-instance deployment wants a shared
 * store (Redis) instead.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  /** Defaults to the client IP. Override to also scope by, say, email. */
  key?: (req: Request) => string;
}) {
  const buckets = new Map<string, Bucket>();
  const keyOf = options.key ?? ((req: Request) => req.ip ?? 'unknown');
  let nextSweep = Date.now() + options.windowMs;

  return function limiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();

    // Drop stale buckets occasionally so the map cannot grow without bound.
    if (now >= nextSweep) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
      nextSweep = now + options.windowMs;
    }

    const key = keyOf(req);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > options.max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({
        error: { message: 'Too many attempts. Please try again shortly.', status: 429 },
      });
      return;
    }

    next();
  };
}
