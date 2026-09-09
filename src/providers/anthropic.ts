import Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider, ChatRequest } from './types.ts';
import { config } from '../config.ts';

const SYSTEM_PROMPT =
  'You are ChatBot AI, a helpful assistant. Answer clearly and concisely. ' +
  'Use Markdown for structure and fenced code blocks for code.';

export class AnthropicProvider implements ChatProvider {
  readonly name = 'anthropic';
  readonly #client: Anthropic;

  constructor(apiKey: string) {
    this.#client = new Anthropic({ apiKey });
  }

  /** Resolves a frontend picker label to an Anthropic model id. */
  #resolveModel(label: string | undefined): string {
    if (label === undefined) return config.provider.model;
    return config.provider.modelMap[label] ?? config.provider.model;
  }

  async *streamChat(request: ChatRequest): AsyncIterable<string> {
    const stream = this.#client.messages.stream(
      {
        model: this.#resolveModel(request.model),
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
