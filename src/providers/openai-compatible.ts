import { UpstreamError, upstreamErrorInfo } from './errors.ts';
import type { ChatProvider, ChatRequest } from './types.ts';

const SYSTEM_PROMPT =
  'You are ChatBot AI, a helpful assistant. Answer clearly and concisely. ' +
  'Use Markdown for structure and fenced code blocks for code.';

/**
 * Statuses worth retrying: transient overloads (503), rate limits (429) and
 * gateway hiccups. Gemini commonly returns 503 "high demand" for a few seconds,
 * so a short exponential backoff recovers most turns instead of failing them.
 */
const RETRYABLE_STATUS = new Set<number>([408, 425, 429, 500, 502, 503, 504]);
/** 1 initial attempt + 3 retries. */
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 600;
const RETRY_MAX_MS = 5000;

function abortError(): Error {
  const error = new Error('The request was aborted.');
  error.name = 'AbortError';
  return error;
}

/** A cancellable sleep: resolves after `ms`, or rejects as soon as the signal aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? abortError());
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? abortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Reads a `Retry-After` header (seconds or HTTP date) into milliseconds. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_MAX_MS);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? Math.min(delta, RETRY_MAX_MS) : 0;
  }
  return undefined;
}

function backoffDelay(attempt: number): number {
  const exponential = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
  return exponential + Math.floor(Math.random() * 250);
}

interface StreamChunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  error?: { message?: string; code?: string | number; status?: string; type?: string };
}

export interface OpenAICompatibleOptions {
  /** Base URL of the vendor, without a trailing slash. */
  baseUrl: string;
  /** Empty string for local runtimes that accept no key. */
  apiKey: string;
  /** Model id sent upstream when the request does not pick one. */
  model: string;
}

/**
 * Talks to any service exposing the OpenAI `/chat/completions` shape — OpenAI,
 * OpenRouter, Groq, Together, DeepSeek, and local Ollama or LM Studio servers.
 * Point AI_BASE_URL at the one you want; the wire format is identical.
 *
 * This is deliberately plain `fetch` rather than the openai package: the
 * request and SSE shapes are the stable part of that ecosystem, and a single
 * dependency-free adapter keeps every compatible vendor on one code path.
 *
 * An instance is fully described by its options and never reads global config,
 * so a request can build one on the fly for a caller-supplied key.
 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly name = 'openai-compatible';
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #model: string;

  constructor(options: OpenAICompatibleOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#model = options.model;
  }

  /** The model id this instance sends unless the caller overrides it. */
  get model(): string {
    return this.#model;
  }

  /**
   * POSTs the chat request, retrying transient upstream failures (Gemini's 503
   * "high demand", 429 rate limits, gateway errors) with exponential backoff +
   * jitter, honouring `Retry-After` when the vendor sends it. Retries happen
   * before any token is yielded, so they never duplicate streamed output.
   */
  async #fetchResponse(request: ChatRequest): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Local runtimes such as Ollama accept an empty key; don't send the header.
    if (this.#apiKey !== '') headers.Authorization = `Bearer ${this.#apiKey}`;

    const body = JSON.stringify({
      model: this.#model,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });
    const url = `${this.#baseUrl}/chat/completions`;

    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        signal: request.signal ?? null,
        body,
      });

      if (response.ok && response.body) return response;

      if (response.ok) {
        throw new UpstreamError('The upstream provider returned an empty stream.', {
          status: 502,
        });
      }

      const text = await response.text().catch(() => '');
      const isLastAttempt = attempt >= MAX_ATTEMPTS - 1;
      if (!isLastAttempt && RETRYABLE_STATUS.has(response.status)) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        await sleep(retryAfter ?? backoffDelay(attempt), request.signal);
        continue;
      }

      // Surface the vendor's own message (e.g. "high demand" or "not found")
      // instead of a generic failure, so the UI can explain what went wrong.
      const { message, code } = upstreamErrorInfo(response.status, response.statusText, text);
      throw new UpstreamError(message, { status: response.status, code });
    }
  }

  async *streamChat(request: ChatRequest): AsyncIterable<string> {
    const response = await this.#fetchResponse(request);

    const decoder = new TextDecoder();
    let buffer = '';

    for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });

      // SSE frames are separated by a blank line; keep the trailing partial.
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const event = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        const content = this.#readEvent(event);
        if (content === DONE) return;
        if (content !== undefined) yield content;

        separator = buffer.indexOf('\n\n');
      }
    }

    // A last frame with no trailing blank line still counts.
    const tail = this.#readEvent(buffer);
    if (tail !== DONE && tail !== undefined) yield tail;
  }

  /** Returns the text in this frame, DONE at end of stream, or undefined. */
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
        const code =
          typeof chunk.error.status === 'string'
            ? chunk.error.status
            : typeof chunk.error.code === 'number' || typeof chunk.error.code === 'string'
              ? String(chunk.error.code)
              : undefined;
        throw new UpstreamError(chunk.error.message ?? 'Upstream provider reported an error', {
          status: 502,
          ...(code !== undefined ? { code } : {}),
        });
      }

      const content = chunk.choices?.[0]?.delta?.content;
      if (typeof content === 'string' && content !== '') return content;
    }
    return undefined;
  }
}

const DONE = Symbol('done');
