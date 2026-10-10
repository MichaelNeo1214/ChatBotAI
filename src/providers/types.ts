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

export interface ChatRequest {
  messages: ChatMessage[];
  /** Label chosen in the frontend model picker, e.g. "ChatBot AI" or "Claude". */
  model?: string;
  signal?: AbortSignal;
}

export interface ChatProvider {
  readonly name: string;
  /** Yields answer text incrementally so routes can stream it to the client. */
  streamChat(request: ChatRequest): AsyncIterable<string>;
}
