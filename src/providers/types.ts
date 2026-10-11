export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Images sent with THIS turn, as already-trusted bytes.
   *
   * Optional and only ever set on a user turn, so every existing caller and
   * provider that ignores it keeps working unchanged. `data` is the raw base64
   * payload (no data: prefix) and `mimeType` is e.g. "image/png".
   */
  images?: ChatImage[];
}

export interface ChatImage {
  mimeType: string;
  data: string;
}

/**
 * Optional per-request generation parameters.
 *
 * Absent fields are omitted from the upstream request so the provider's own
 * default applies — important for the free tier, where the routed models
 * disagree about sensible defaults.
 */
export interface ChatParameters {
  /** Replaces the adapter's built-in assistant prompt for this turn. */
  systemPrompt?: string;
  /** Sampling temperature, 0 (deterministic) to 2. */
  temperature?: number;
  /** Nucleus sampling, greater than 0 and at most 1. */
  topP?: number;
  /** Upper bound on generated tokens. */
  maxTokens?: number;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Label chosen in the frontend model picker, e.g. "OpenRouter Free" or "Claude". */
  model?: string;
  signal?: AbortSignal;
  parameters?: ChatParameters;
}

export interface ChatProvider {
  readonly name: string;
  /** Yields answer text incrementally so routes can stream it to the client. */
  streamChat(request: ChatRequest): AsyncIterable<string>;
}
