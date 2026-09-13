import Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider, ChatRequest } from './types.ts';

const SYSTEM_PROMPT =
  'You are ChatBot AI, a helpful assistant. Answer clearly and concisely. ' +
  'Use Markdown for structure and fenced code blocks for code.';

export interface AnthropicOptions {
  apiKey: string;
  /** Model id sent upstream. */
  model: string;
}

/**
 * Talks to the Anthropic Messages API through the official SDK.
 *
 * An instance is fully described by its options and never reads global config,
 * so a request can build one on the fly for a caller-supplied key.
 */
export class AnthropicProvider implements ChatProvider {
  readonly name = 'anthropic';
  readonly #client: Anthropic;
  readonly #model: string;

  constructor(options: AnthropicOptions) {
    this.#client = new Anthropic({ apiKey: options.apiKey });
    this.#model = options.model;
  }

  /** The model id this instance sends. */
  get model(): string {
    return this.#model;
  }

  async *streamChat(request: ChatRequest): AsyncIterable<string> {
    const stream = this.#client.messages.stream(
      {
        model: this.#model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      },
      { signal: request.signal },
    );

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      throw new Error('The model declined to answer this request.');
    }
  }
}
