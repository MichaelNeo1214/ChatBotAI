import type { ChatProvider, ChatRequest } from './types.ts';

const REPLIES = [
  "I'm the mock provider, so this reply is canned rather than generated. Set AI_PROVIDER=anthropic and AI_API_KEY in .env to get real answers.",
  'Mock provider here. The request reached the server, the conversation was saved, and this text streamed back over SSE — the whole path works end to end.',
  "This is placeholder text from the mock provider. Everything except the model call is real: routing, validation, persistence, and streaming.",
];

/**
 * Streams canned text so the full request path can be exercised without an API
 * key or network access. Useful in tests and for frontend work.
 */
export class MockProvider implements ChatProvider {
  readonly name = 'mock';

  async *streamChat(request: ChatRequest): AsyncIterable<string> {
    const last = request.messages.at(-1);
    const index = (last?.content.length ?? 0) % REPLIES.length;
    const reply = `${REPLIES[index] ?? REPLIES[0]}\n\nYou said: "${last?.content ?? ''}"`;

    // Emit word by word so the client sees a realistic token stream.
    for (const word of reply.split(/(\s+)/)) {
      request.signal?.throwIfAborted();
      yield word;
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
  }
}
