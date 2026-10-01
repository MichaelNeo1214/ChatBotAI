import type { NextFunction, Request, Response } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Defaults to the client IP. Override to also scope by, say, email. */
  key?: (req: Request) => string;
  /** Machine-readable reason in the 429 body, e.g. "rate_limited". */
  code?: string;
  /** Human-readable message in the 429 body. */
  message?: string;
}

/**
 * A small fixed-window limiter held in memory. Enough to blunt password
 * guessing or a runaway chat loop on a single instance; a multi-instance
 * deployment wants a shared store (Redis) instead.
 */
export function rateLimit(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  const keyOf = options.key ?? ((req: Request) => req.ip ?? 'unknown');
  const message = options.message ?? 'Too many attempts. Please try again shortly.';
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
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      const body: Record<string, unknown> = { message, status: 429, retryAfter };
      if (options.code !== undefined) body.code = options.code;
      res.status(429).json({ error: body });
      return;
    }

    next();
  };
}
