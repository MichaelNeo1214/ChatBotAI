import type { NextFunction, Request, Response } from 'express';
import { isProduction } from '../config.ts';

/** An error carrying the HTTP status the client should see. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message: string) => new HttpError(404, message);

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(notFound(`No route for ${req.method} ${req.path}`));
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    // A stream already started; let Express tear the connection down.
    next(err);
    return;
  }

  const status = err instanceof HttpError ? err.status : 500;
  const message =
    err instanceof HttpError || !isProduction
      ? (err as Error).message
      : 'Internal server error';

  if (status >= 500) {
    console.error('[error]', err);
  }

  res.status(status).json({ error: { message, status } });
}
