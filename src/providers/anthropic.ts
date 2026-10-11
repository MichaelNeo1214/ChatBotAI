import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatProvider, ChatRequest } from './types.ts';

const SYSTEM_PROMPT =
  'You are SpaceBunny Free MAX, a helpful assistant. Answer clearly and concisely. ' +
  'Use Markdown for structure and fenced code blocks for code. ' +
  'Render mathematical notation with LaTeX delimiters: $...$ inline and $$...$$ on its own line.';

export interface AnthropicOptions {
  apiKey: string;
  /** Model id sent upstream. */
  model: string;
}

/** The exact media types the Anthropic image block accepts. */
type AnthropicMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** One block of an Anthropic message: plain text, or an inline base64 image. */
type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: AnthropicMediaType; data: string } };

/** Widens a validated MIME string, falling back to PNG (our validator never emits others). */
function anthropicMediaType(mimeType: string): AnthropicMediaType {
  return mimeType === 'image/jpeg' || mimeType === 'image/gif' || mimeType === 'image/webp'
    ? mimeType
    : 'image/png';
}

/**
 * Maps one turn onto the Anthropic content shape.
 *
 * Text-only turns keep the plain string form every release accepts; only a turn
 * that carries images becomes a block array, so ordinary text conversations are
 * unaffected.
 */
function toAnthropicMessage(message: ChatMessage): { role: 'user' | 'assistant'; content: string | AnthropicBlock[] } {
  const images = message.images;
  if (images === undefined || images.length === 0) {
    return { role: message.role, content: message.content };
  }

  const blocks: AnthropicBlock[] = [];
  if (message.content !== '') blocks.push({ type: 'text', text: message.content });
  for (const image of images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: anthropicMediaType(image.mimeType), data: image.data },
    });
  }
  return { role: message.role, content: blocks };
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
        messages: request.messages.map(toAnthropicMessage),
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
