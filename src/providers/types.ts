export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Label chosen in the frontend model picker, e.g. "ChatBot AI" or "Claude". */
  model?: string;
  /** Replaces the adapter's default system prompt when set. */
  system?: string;
  signal?: AbortSignal;
}

export interface ChatProvider {
  readonly name: string;
  /** Yields answer text incrementally so routes can stream it to the client. */
  streamChat(request: ChatRequest): AsyncIterable<string>;
}
