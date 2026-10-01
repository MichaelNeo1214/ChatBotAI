import type { NextFunction, Request, Response } from 'express';
import { isProduction } from '../config.ts';

/** Extra fields merged into the `error` object of the JSON body. */
export type ErrorExtra = Record<string, unknown>;

export interface HttpErrorOptions {
  /** Machine-readable reason, e.g. "unknown_model". */
  code?: string;
  /** Extra JSON fields for the client, e.g. { model: "GPT-4o" }. */
  extra?: ErrorExtra;
}

/** An error carrying the HTTP status the client should see. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly extra: ErrorExtra | undefined;

  constructor(status: number, message: string, options: HttpErrorOptions = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = options.code;
    this.extra = options.extra;
  }
}

export const badRequest = (message: string, options: HttpErrorOptions = {}) =>
  new HttpError(400, message, options);
export const notFound = (message: string) => new HttpError(404, message);
export const unauthorized = (message: string) => new HttpError(401, message);

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

  const body: Record<string, unknown> = { message, status };

  if (err instanceof HttpError) {
    if (err.code !== undefined) body.code = err.code;
    // `extra` carries contract fields such as `model` for missing_api_key.
    if (err.extra !== undefined) Object.assign(body, err.extra);
  }

  if (status >= 500) {
    console.error('[error]', err);
  }

  res.status(status).json({ error: body });
}
