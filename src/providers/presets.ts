/**
 * Model labels, presets, and the default free engine.
 *
 * The frontend model picker shows these labels. The default label is
 * deliberately NOT here: it is served by the server's own env-configured
 * provider, so a visitor needs no API key of their own. Every preset below is
 * instead called with the key the client sends on the request
 * (X-Provider-Key), which is never stored on the server.
 *
 * `baseUrl` is omitted for adapters that talk to a fixed endpoint of their own
 * (anthropic) and present for adapters that need a vendor URL.
 */
export interface ProviderPreset {
  /** Which adapter builds the per-request provider. */
  adapter: 'openai-compatible' | 'anthropic';
  /** Upstream base URL; absent for adapters with a fixed endpoint. */
  baseUrl?: string;
  /** Model id sent upstream unless the request overrides it. */
  model: string;
}

export const PROVIDER_PRESETS: Readonly<Record<string, ProviderPreset>> = {
  'GPT-4o': {
    adapter: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  },
  Gemini: {
    adapter: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    /**
     * Google shut down gemini-2.0-flash on 2026-06-01 and limits the 2.5
     * family to previously-active projects, so both of those 404 for new keys.
     * This is the current general-availability Flash model (also the id shown
     * in Google's OpenAI-compatibility docs). It can be overridden per request
     * with the X-Provider-Model header.
     */
    model: 'gemini-3.8-flash',
  },
  DeepSeek: {
    adapter: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  Groq: {
    adapter: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    /**
     * Groq decommissioned llama-3.3-70b-versatile and llama-3.1-8b-instant on
     * 2026-08-16, so the preset points at its current production flagship,
     * openai/gpt-oss-120b (OpenAI-compatible chat/completions). Override per
     * request with the X-Provider-Model header.
     */
    model: 'openai/gpt-oss-120b',
  },
  Claude: {
    adapter: 'anthropic',
    /**
     * claude-opus-5 is a real Anthropic API id (GA 2026-07-24, alias and id
     * are identical). An earlier version of this comment claimed it was not a
     * published id; that was wrong. Callers can still pin a cheaper or faster
     * model — claude-sonnet-5, claude-haiku-4-5 — with X-Provider-Model.
     */
    model: 'claude-opus-5',
  },
};

/**
 * The picker label for the server's own provider — Space Bunny Alpha, served
 * on the deployment's key so that visitors never need to supply one.
 */
export const DEFAULT_MODEL_LABEL = 'SpaceBunny Free MAX';

/**
 * Labels that also mean "the server's own provider".
 *
 * `ChatBot AI` was the label before the free tier was renamed, and it is what
 * every conversation saved in an older deployment still carries. Accepting it
 * keeps that history readable instead of 400-ing as an unknown model.
 */
export const DEFAULT_MODEL_ALIASES: readonly string[] = ['ChatBot AI'];

/** True when a picker label routes to the server's own provider. */
export const isDefaultModelLabel = (label: string | undefined | null): boolean => {
  if (label === undefined || label === null) return true;
  const trimmed = label.trim();
  return trimmed === '' || trimmed === DEFAULT_MODEL_LABEL || DEFAULT_MODEL_ALIASES.includes(trimmed);
};

export const isKnownModelLabel = (label: string): boolean =>
  Object.prototype.hasOwnProperty.call(PROVIDER_PRESETS, label);