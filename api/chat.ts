/**
 * POST /api/chat — Vercel Serverless Function (stateless).
 *
 * This is the deploy target for the browser's chat request. Unlike the local
 * Express server (src/), it keeps NOTHING server-side: no SQLite, no sessions,
 * no conversation store. The client sends the recent turns in `history` and the
 * new turn in `message`, and this function streams the answer back as SSE.
 *
 * Body:
 *   {
 *   "message": string,                 // the new user turn (required)
 *   "model"?: string,                  // picker label; omitted = server default
 *   "history"?: { role, content }[],   // prior turns (oldest -> newest)
 *   "conversationId"?: string,         // accepted but ignored (no server DB)
 *   "parameters"?: {                   // optional generation settings
 *     "systemPrompt"?: string,
 *     "temperature"?: number,          // 0..2
 *     "topP"?: number,                 // >0..1
 *     "maxTokens"?: number             // 1..64000
 *   },
 *   "attachments"?: {                  // optional multimodal input
 *     "images"?: ({ mimeType?, data } | "data:image/...")[],
 *     "document"?: { name, text }      // plain-text file (.txt/.md/.csv)
 *   }
 *   }
 *
 * Bring-your-own-key / self-hosted routing (same contract as the Express app):
 *   X-Provider-Key       required for a preset model (e.g. "GPT-4o")
 *   X-Provider-Base-Url  optional   overrides the upstream URL (self-hosted)
 *   X-Provider-Model     optional   overrides the upstream model id
 *
 * SSE events (identical to the Express route so the frontend is unchanged):
 *   event: meta   { model }
 *   event: delta  { text }
 *   event: done   { content }
 *   event: error  { message }
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../src/config.ts';
import { AnthropicProvider } from '../src/providers/anthropic.ts';
import { documentBlock, parseAttachments } from '../src/providers/attachments.ts';
import { UpstreamError } from '../src/providers/errors.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.ts';
import { parseChatParameters } from '../src/providers/parameters.ts';
import { PROVIDER_PRESETS, isDefaultModelLabel } from '../src/providers/presets.ts';
import type { ChatMessage, ChatProvider } from '../src/providers/types.ts';

const MAX_MESSAGE_LENGTH = 32_000;
const HISTORY_LIMIT = 40;
const MAX_KEY_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
const MAX_MODEL_LENGTH = 200;
const MAX_LABEL_LENGTH = 100;

interface ChatBody {
  message?: unknown;
  model?: unknown;
  history?: unknown;
  conversationId?: unknown;
  parameters?: unknown;
  attachments?: unknown;
}

type Req = IncomingMessage & { body?: unknown };
type Res = ServerResponse;

/** An error that maps to a specific HTTP status + JSON body for the client. */
class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly model: string | undefined;
  /** The upstream vendor's own error code, when the failure came from a model API. */
  readonly upstreamCode: string | undefined;

  constructor(
    status: number,
    message: string,
    options: { code?: string; model?: string; upstreamCode?: string } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = options.code;
    this.model = options.model;
    this.upstreamCode = options.upstreamCode;
  }
}

function sendJson(res: Res, status: number, error: Record<string, unknown>): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: { status, ...error } }));
}

function getHeader(req: Req, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

/**
 * Cross-origin guard for browser traffic.
 *
 * This endpoint accepts a caller-supplied provider key (BYOK), so a page on
 * another origin must not be able to make the browser attach one. A strict
 * `origin === 'https://chat.michaelap.my.id'` check would also reject local
 * development and every Vercel preview deployment, which are separate hosts.
 * The allowlist below is the same list the Express build uses.
 *
 * Requests with no Origin header are NOT blocked: they are not browser XHR
 * (curl, the Vercel CLI, health probes), and a browser always sends Origin on
 * a cross-origin POST.
 */
function originAllowed(req: Req): boolean {
  const origin = getHeader(req, 'origin');
  if (origin === undefined || origin === '') return true;

  const allowed = config.corsOrigins;
  if (allowed.includes(origin)) return true;

  // Same-origin browsers report their own address. Accepting a match against
  // the Host header keeps the deployed domain working without hard-coding it,
  // which also covers preview and alias hostnames.
  const host = getHeader(req, 'host');
  if (host !== undefined) {
    try {
      if (new URL(origin).host === host) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function sendCorsHeaders(res: Res, req: Req): void {
  const origin = getHeader(req, 'origin');
  if (origin === undefined || origin === '') return;
  if (!originAllowed(req)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Provider-Key, X-Provider-Base-Url, X-Provider-Model');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

/** JSON body from Vercel's parser, or read it ourselves if it is not present. */
async function readBody(req: Req): Promise<ChatBody> {
  const pre = req.body;
  if (pre !== undefined && pre !== null) {
    if (typeof pre === 'object') return pre as ChatBody;
    if (typeof pre === 'string') {
      try {
        return JSON.parse(pre) as ChatBody;
      } catch {
        return {};
      }
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  try {
    return JSON.parse(text) as ChatBody;
  } catch {
    return {};
  }
}

/** Keeps only well-formed {role, content} turns, newest last, capped. */
function normalizeHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ChatMessage[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content !== '') {
      out.push({ role, content: content.slice(0, MAX_MESSAGE_LENGTH) });
    }
  }
  return out.slice(-HISTORY_LIMIT);
}

/**
 * Chooses the upstream provider for this request — the multi-model switch.
 *
 *   - no label / the default label -> the server's own env-configured provider
 *   - "GPT-4o" / "Gemini" / "DeepSeek" / "Groq" -> OpenAI-compatible, using the caller's key
 *   - "Claude" -> Anthropic Messages API, using the caller's key
 *   - X-Provider-Base-Url on any preset -> talk to a self-hosted endpoint instead
 */
function selectProvider(modelLabel: unknown, req: Req): { provider: ChatProvider; model: string } {
  const label = typeof modelLabel === 'string' ? modelLabel.trim() : '';

  // isDefaultModelLabel also accepts the pre-rename "ChatBot AI" label, which
  // is what every conversation saved before the free tier was named carries.
  if (isDefaultModelLabel(label)) {
    switch (config.provider.name) {
      case 'anthropic': {
        if (config.provider.apiKey === '') {
          throw new ApiError(400, 'The server has no AI_API_KEY set for the default model.', {
            code: 'missing_api_key',
          });
        }
        return {
          provider: new AnthropicProvider({
            apiKey: config.provider.apiKey,
            model: config.provider.model,
          }),
          model: config.provider.model,
        };
      }

      case 'openai-compatible': {
        if (config.provider.apiKey === '') {
          throw new ApiError(400, 'The server has no AI_API_KEY set for the default model.', {
            code: 'missing_api_key',
          });
        }
        return {
          provider: new OpenAICompatibleProvider({
            baseUrl: config.provider.baseUrl,
            apiKey: config.provider.apiKey,
            model: config.provider.model,
            reasoningEffort: config.provider.reasoningEffort,
            systemPrompt: config.provider.systemPrompt,
          }),
          model: config.provider.model,
        };
      }

      case 'mock':
      default:
        return { provider: new MockProvider(), model: config.provider.model };
    }
  }

  // ---- BYOK / self-hosted presets, keyed by the picker label ----
  if (label.length > MAX_LABEL_LENGTH) {
    throw new ApiError(400, 'Unknown model.', { code: 'unknown_model' });
  }
  const preset = PROVIDER_PRESETS[label];
  if (preset === undefined) {
    throw new ApiError(400, `Unknown model "${label}".`, { code: 'unknown_model' });
  }

  const apiKey = getHeader(req, 'x-provider-key');
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new ApiError(400, `Add an API key for ${label} in Settings`, {
      code: 'missing_api_key',
      model: label,
    });
  }
  if (apiKey.length >= MAX_KEY_LENGTH) {
    throw new ApiError(400, 'The API key header is too long.', {
      code: 'invalid_provider_config',
      model: label,
    });
  }

  // Self-hosted override: a preset can be pointed at any OpenAI-compatible URL.
  let baseUrl = preset.baseUrl;
  const overrideUrl = getHeader(req, 'x-provider-base-url');
  if (overrideUrl !== undefined && overrideUrl.trim() !== '') {
    const trimmed = overrideUrl.trim();
    if (trimmed.length > MAX_URL_LENGTH) {
      throw new ApiError(400, 'The base URL header is too long.', {
        code: 'invalid_provider_config',
        model: label,
      });
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new ApiError(400, 'The base URL header must be a valid http(s) URL.', {
        code: 'invalid_provider_config',
        model: label,
      });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ApiError(400, 'The base URL header must use http or https.', {
        code: 'invalid_provider_config',
        model: label,
      });
    }
    baseUrl = trimmed.replace(/\/+$/, '');
  }

  const overrideModel = (getHeader(req, 'x-provider-model') ?? '').trim();
  const model = overrideModel !== '' ? overrideModel : preset.model;
  if (model.length >= MAX_MODEL_LENGTH) {
    throw new ApiError(400, 'The model header is too long.', {
      code: 'invalid_provider_config',
      model: label,
    });
  }

  switch (preset.adapter) {
    case 'anthropic':
      return { provider: new AnthropicProvider({ apiKey, model }), model };

    case 'openai-compatible':
    default: {
      if (baseUrl === undefined) {
        throw new ApiError(400, `No base URL is configured for ${label}.`, {
          code: 'invalid_provider_config',
          model: label,
        });
      }
      return { provider: new OpenAICompatibleProvider({ baseUrl, apiKey, model }), model };
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return 'The assistant failed to finish this response.';
}

/** The HTTP status carried by a provider failure, defaulting to 502. */
function upstreamStatusOf(error: unknown): number {
  if (error instanceof UpstreamError) return error.status;
  const candidate = (error as { status?: unknown } | null)?.status;
  return typeof candidate === 'number' ? candidate : 502;
}

/**
 * Wraps a provider failure so the client receives the vendor's own status and
 * message (e.g. a 404 "models/gemini-... is not found") rather than a generic
 * server error.
 */
function toUpstreamApiError(error: unknown, model: string): ApiError {
  const status = upstreamStatusOf(error);
  const safe = status >= 400 && status <= 599 ? status : 502;
  const upstreamCode = error instanceof UpstreamError ? error.code : undefined;
  return new ApiError(safe, errorMessage(error), {
    code: 'upstream_error',
    model,
    ...(upstreamCode !== undefined ? { upstreamCode } : {}),
  });
}

export default async function handler(req: Req, res: Res): Promise<void> {
  // CORS headers first so an error response is still readable by the browser.
  if ((req.method ?? 'GET').toUpperCase() === 'OPTIONS') {
    if (!originAllowed(req)) {
      sendJson(res, 403, { code: 'forbidden_origin', message: 'Origin not allowed.' });
      return;
    }
    sendCorsHeaders(res, req);
    res.setHeader('Allow', 'POST, OPTIONS');
    res.statusCode = 204;
    res.end();
    return;
  }

  // 1. Method guard — the explicit fix for the 405.
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, {
      code: 'method_not_allowed',
      message: 'Use POST for /api/chat.',
    });
    return;
  }

  // 2. Origin guard. Runs before the body is read so a rejected caller cannot
  // make the function buffer a payload or spend time on it.
  if (!originAllowed(req)) {
    sendJson(res, 403, {
      code: 'forbidden_origin',
      message: 'This endpoint cannot be called from that origin.',
    });
    return;
  }
  sendCorsHeaders(res, req);

  try {
    const body = await readBody(req);

    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (message === '') {
      throw new ApiError(400, '"message" is required and must be a non-empty string.', {
        code: 'bad_request',
      });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new ApiError(400, `"message" must be at most ${MAX_MESSAGE_LENGTH} characters.`, {
        code: 'bad_request',
      });
    }
    if (body.model != null && typeof body.model !== 'string') {
      throw new ApiError(400, '"model" must be a string when provided.', { code: 'bad_request' });
    }

    // Validated before the provider is chosen or any bytes are written, so a
    // bad slider value is a clean JSON 400 rather than a broken stream.
    const parsedParameters = parseChatParameters(body.parameters);
    if (!parsedParameters.ok) {
      throw new ApiError(400, parsedParameters.error ?? 'Invalid parameters.', {
        code: 'bad_request',
      });
    }
    const parameters = parsedParameters.value;

    const { provider, model } = selectProvider(body.model, req);
    const history = normalizeHistory(body.history);

    // Multimodal input is optional and validated centrally, so a plain-text
    // turn produces exactly the same ChatMessage it did before this existed.
    const attachment = parseAttachments(body.attachments);
    let prompt = message;
    if (attachment.documentText !== '') {
      prompt = `${documentBlock(attachment.documentName, attachment.documentText)}\n\n${message}`;
    }
    const currentTurn: ChatMessage = {
      role: 'user',
      content: prompt,
      ...(attachment.images.length > 0 ? { images: attachment.images } : {}),
    };
    const messages: ChatMessage[] = [...history, currentTurn];

    const abort = new AbortController();
    req.on('close', () => abort.abort());

    // 2. Stream the answer as Server-Sent Events.
    //
    // The SSE headers are withheld until the upstream yields its first token.
    // If the provider fails first — the usual case when a model id is retired
    // or unknown (Gemini 404) — nothing has been written yet, so we can still
    // reply with a genuine JSON error carrying the vendor's status and message.
    let started = false;
    const startSse = (): void => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.write(`event: meta\ndata: ${JSON.stringify({ model })}\n\n`);
      started = true;
    };
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let answer = '';
    try {
      for await (const chunk of provider.streamChat({
        messages,
        signal: abort.signal,
        ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
      })) {
        if (!started) startSse();
        answer += chunk;
        send('delta', { text: chunk });
      }
    } catch (error) {
      if (abort.signal.aborted) {
        res.end();
        return;
      }
      if (!started) {
        // Nothing streamed yet: hand the real upstream failure to the client,
        // which surfaces it through the normal non-2xx JSON error path.
        throw toUpstreamApiError(error, model);
      }
      send('error', { message: errorMessage(error) });
      res.end();
      return;
    }

    if (!started) startSse();
    send('done', { content: answer });
    res.end();
  } catch (error) {
    if (error instanceof ApiError) {
      sendJson(res, error.status, {
        code: error.code,
        message: error.message,
        ...(error.model !== undefined ? { model: error.model } : {}),
        ...(error.upstreamCode !== undefined ? { upstreamCode: error.upstreamCode } : {}),
      });
      return;
    }
    console.error('[api/chat]', error);
    sendJson(res, 500, { code: 'internal_error', message: 'Internal server error' });
  }
}
