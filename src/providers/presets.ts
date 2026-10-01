/**
 * Presets for "bring your own key" models.
 *
 * The frontend model picker shows these labels. `ChatBot AI` is deliberately
 * NOT here: it is the team's default model, served by the boot-time provider
 * with the server's own `.env` key. Every preset below is instead called with
 * the key the client sends on the request (X-Provider-Key), which is never
 * stored on the server.
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
    model: 'gemini-2.0-flash',
  },
  DeepSeek: {
    adapter: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  Claude: {
    adapter: 'anthropic',
    /**
     * Shipped verbatim from the agreed contract: the preset model id is
     * "claude-opus-5". NOTE: that is not a model id Anthropic publishes, and an
     * empty id is not usable either (the SDK rejects it before sending), so a
     * bare "Claude" request with no X-Provider-Model cannot succeed upstream.
     * Callers must send X-Provider-Model. Flagged in the PR as unverifiable.
     */
    model: 'claude-opus-5',
  },
};

/** The label that means "the server's own provider", not a BYOK preset. */
export const DEFAULT_MODEL_LABEL = 'ChatBot AI';

export const isKnownModelLabel = (label: string): boolean =>
  Object.prototype.hasOwnProperty.call(PROVIDER_PRESETS, label);
