/**
 * Errors raised when an upstream model API answers with a non-2xx status.
 *
 * Vendors disagree on the shape of their error bodies: OpenAI/Gemini usually
 * send `{ error: { message, code, status } }`, but the Gemini OpenAI-compatible
 * layer sometimes wraps it in an array (`[ { error: { ... } } ]`), Anthropic
 * uses `{ error: { message, type } }`, and some gateways return plain text.
 * `upstreamErrorInfo` normalises all of these to one readable message + code so
 * the real reason ("This model is currently experiencing high demand ...")
 * reaches the browser instead of a wall of raw JSON.
 */
export class UpstreamError extends Error {
  /** The HTTP status the vendor returned (404, 400, 403, 503, ...). */
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

interface Extracted {
  message: string;
  code?: string;
}

/**
 * Walks an arbitrary parsed error payload looking for the first useful message.
 * Handles arrays (vendor wrappers), `{ error: ... }` objects, `{ error: "..." }`
 * strings, and plain `{ message }` objects.
 */
function extract(value: unknown, depth = 0): Extracted | undefined {
  if (depth > 5) return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extract(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? undefined : { message: text };
  }

  if (value === null || typeof value !== 'object') return undefined;
  const bag = value as Record<string, unknown>;

  const error = bag.error;
  if (error !== undefined && error !== null) {
    const nested = extract(error, depth + 1);
    if (nested !== undefined) {
      const code = nested.code ?? toCode(bag.status) ?? toCode(bag.code) ?? toCode(bag.type);
      return code !== undefined ? { message: nested.message, code } : { message: nested.message };
    }
  }

  const message = typeof bag.message === 'string' ? bag.message.trim() : '';
  if (message !== '') {
    const code = toCode(bag.status) ?? toCode(bag.code) ?? toCode(bag.type);
    return code !== undefined ? { message, code } : { message };
  }

  // `error`/`message` were present but held no text; try the other key.
  if (error !== undefined && error !== null) {
    const nested = extract(error, depth + 1);
    if (nested !== undefined) return nested;
  }

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
  if (trimmed === '') {
    return { message: `Upstream provider returned ${status} ${statusText}`.trim() };
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const found = extract(parsed);
    if (found !== undefined) {
      return found.code !== undefined ? { message: found.message, code: found.code } : { message: found.message };
    }
  } catch {
    // Not JSON — some vendors return HTML or plain text on failure.
    return { message: trimmed.slice(0, 500) };
  }

  return { message: trimmed.slice(0, 500) };
}
