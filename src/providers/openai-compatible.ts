import { config } from '../config.ts';
import type { ChatProvider, ChatRequest } from './types.ts';

const SYSTEM_PROMPT =
  'You are ChatBot AI, a helpful assistant. Answer clearly and concisely. ' +
  'Use Markdown for structure and fenced code blocks for code.';

interface StreamChunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  error?: { message?: string };
}

/**
 * Talks to any service exposing the OpenAI `/chat/completions` shape — OpenAI,
 * OpenRouter, Groq, Together, DeepSeek, and local Ollama or LM Studio servers.
 * Point AI_BASE_URL at the one you want; the wire format is identical.
 *
 * This is deliberately plain `fetch` rather than the openai package: the
 * request and SSE shapes are the stable part of that ecosystem, and a single
 * dependency-free adapter keeps every compatible vendor on one code path.
 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly name = 'openai-compatible';
  readonly #baseUrl: string;
  readonly #apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.#baseUrl = baseUrl;
    this.#apiKey = apiKey;
  }

  /** Resolves a frontend picker label to the upstream model id. */
  #resolveModel(label: string | undefined): string {
    if (label === undefined) return config.provider.model;
    return config.provider.modelMap[label] ?? config.provider.model;
  }

  async *streamChat(request: ChatRequest): AsyncIterable<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Local runtimes such as Ollama accept an empty key; don't send the header.
    if (this.#apiKey !== '') headers.Authorization = `Bearer ${this.#apiKey}`;

    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: request.signal ?? null,
      body: JSON.stringify({
        model: this.#resolveModel(request.model),
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...request.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Upstream provider returned ${response.status} ${response.statusText}${
          detail ? `: ${detail.slice(0, 500)}` : ''
        }`,
      );
    }

    const decoder = new TextDecoder();
    let buffer = '';

    for await (const bytes of response.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });

      // SSE events are separated by a blank line; a chunk can split one in half.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const text = this.#readEvent(event);
        if (text === DONE) return;
        if (text !== undefined) yield text;
      }
    }
  }

  /** Returns the text of one SSE event, DONE at end of stream, or undefined. */
  #readEvent(event: string): string | typeof DONE | undefined {
    for (const line of event.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const payload = trimmed.slice('data:'.length).trim();
      if (payload === '[DONE]') return DONE;
      if (payload === '') continue;

      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        // A vendor keep-alive or comment line; nothing to emit.
        continue;
      }

      if (chunk.error) {
        throw new Error(chunk.error.message ?? 'Upstream provider reported an error');
      }

      const content = chunk.choices?.[0]?.delta?.content;
      if (typeof content === 'string' && content !== '') return content;
    }
    return undefined;
  }
}

const DONE = Symbol('done');
