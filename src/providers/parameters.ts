import { badRequest } from '../middleware/errors.ts';
import type { ChatParameters } from './types.ts';

/**
 * Per-request generation parameters.
 *
 * Every field is optional: when one is absent the provider's own default
 * applies. That matters for the free tier, whose models disagree about what a
 * sensible default is, and it keeps the wire format unchanged for callers that
 * never send these.
 */

const MAX_SYSTEM_PROMPT_LENGTH = 8_000;
const MAX_TOKENS_LIMIT = 64_000;

export interface ParseResult {
  ok: boolean;
  value: ChatParameters;
  /** Human-readable reason, suitable for a 400 body. */
  error?: string;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Validates the optional `parameters` object on a chat request.
 *
 * Returns a result rather than throwing so the Express route and the
 * serverless handler can each raise their own error type without duplicating
 * the rules. Out-of-range values are rejected rather than silently clamped:
 * a slider cannot produce them, and quietly changing what was asked for hides
 * the mistake.
 */
export function parseChatParameters(input: unknown): ParseResult {
  const out: ChatParameters = {};
  if (input === undefined || input === null) return { ok: true, value: out };

  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, value: out, error: '"parameters" must be an object.' };
  }

  const raw = input as Record<string, unknown>;

  const systemPrompt = raw.systemPrompt;
  if (systemPrompt !== undefined && systemPrompt !== null && systemPrompt !== '') {
    if (typeof systemPrompt !== 'string') {
      return { ok: false, value: out, error: '"parameters.systemPrompt" must be a string.' };
    }
    if (systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
      return {
        ok: false,
        value: out,
        error: `"parameters.systemPrompt" must be at most ${MAX_SYSTEM_PROMPT_LENGTH} characters.`,
      };
    }
    out.systemPrompt = systemPrompt;
  }

  const temperature = raw.temperature;
  if (temperature !== undefined && temperature !== null && temperature !== '') {
    const value = num(temperature);
    if (value === undefined || value < 0 || value > 2) {
      return {
        ok: false,
        value: out,
        error: '"parameters.temperature" must be a number between 0 and 2.',
      };
    }
    out.temperature = value;
  }

  const topP = raw.topP ?? raw.top_p;
  if (topP !== undefined && topP !== null && topP !== '') {
    const value = num(topP);
    if (value === undefined || value <= 0 || value > 1) {
      return {
        ok: false,
        value: out,
        error: '"parameters.topP" must be a number greater than 0 and at most 1.',
      };
    }
    out.topP = value;
  }

  const maxTokens = raw.maxTokens ?? raw.max_tokens;
  if (maxTokens !== undefined && maxTokens !== null && maxTokens !== '') {
    const value = num(maxTokens);
    if (value === undefined || !Number.isInteger(value) || value < 1 || value > MAX_TOKENS_LIMIT) {
      return {
        ok: false,
        value: out,
        error: `"parameters.maxTokens" must be a whole number between 1 and ${MAX_TOKENS_LIMIT}.`,
      };
    }
    out.maxTokens = value;
  }

  return { ok: true, value: out };
}

/** Express-flavoured wrapper that throws the route's own 400 error. */
export function parseChatParametersOrThrow(input: unknown): ChatParameters {
  const result = parseChatParameters(input);
  if (!result.ok) throw badRequest(result.error ?? 'Invalid parameters.');
  return result.value;
}
