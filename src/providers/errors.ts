/**
 * Errors raised when an upstream model API answers with a non-2xx status.
 *
 * Vendors disagree on the shape of their error bodies (OpenAI/Gemini use
 * `{ error: { message, code, status } }`, Anthropic uses
 * `{ error: { message, type } }`, some return plain text). `upstreamErrorInfo`
 * normalises all of them to a single readable message + code so the real reason
 * ("models/gemini-2.0-flash is not found ...") reaches the browser instead of a
 * generic "something failed".
 */
export class UpstreamError extends Error {
  /** The HTTP status the vendor returned (404, 400, 403, ...). */
  readonly status: number;
  /** The vendor's own machine-readable code, when it sent one. */
  readonly code: string | undefined;

  constructor(message: string, options: { status: number; code?: string }) {
    super(message);
    this.name = 'UpstreamError';
    this.status = options.status;
    this.code = options.code;
  }
}

function toCode(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Extracts a human-readable message and vendor code from an error response.
 * Falls back to the raw (trimmed) body, then to the status line.
 */
export function upstreamErrorInfo(
  status: number,
  statusText: string,
  body: string,
): { message: string; code?: string } {
  const trimmed = body.trim();

  if (trimmed !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not JSON — some vendors return HTML or plain text on failure.
      return { message: trimmed.slice(0, 500) };
    }

    const error = (parsed as { error?: unknown } | null)?.error;
    if (typeof error === 'string' && error.trim() !== '') {
      return { message: error.trim() };
    }
    if (error !== null && typeof error === 'object') {
      const bag = error as Record<string, unknown>;
      const message = typeof bag.message === 'string' ? bag.message.trim() : '';
      // Prefer the symbolic status ("NOT_FOUND") over the numeric one.
      const code = toCode(bag.status) ?? toCode(bag.code) ?? toCode(bag.type);
      if (message !== '') return code !== undefined ? { message, code } : { message };
    }

    const topMessage = (parsed as { message?: unknown } | null)?.message;
    if (typeof topMessage === 'string' && topMessage.trim() !== '') {
      return { message: topMessage.trim() };
    }

    return { message: trimmed.slice(0, 500) };
  }

  return { message: `Upstream provider returned ${status} ${statusText}`.trim() };
}
