/**
 * POST /api/image — generate one image from a text prompt (stateless).
 *
 * Sibling of /api/chat: same deploy target, same BYOK trust model (the key is
 * read from a request header, used once, and never stored). Unlike chat this is
 * a plain JSON request/response — image APIs return a base64 payload, not an
 * SSE token stream — so the client gets `{ image: { dataUrl, mimeType } }`.
 *
 * Body:
 *   {
 *     "prompt":   string,               // the image description (required)
 *     "provider": "openai" | "gemini",  // which Images API to call (required)
 *     "model"?:   string                // accepted but ignored; use the header
 *   }
 *
 * Bring-your-own-key routing:
 *   X-Provider-Key       required; the caller's OpenAI or Gemini key
 *   X-Provider-Base-Url  optional; overrides the vendor base URL
 *   X-Provider-Model     optional; overrides the image model id
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { UpstreamError } from '../src/providers/errors.ts';
import { generateImage, type ImageBackend } from '../src/providers/image.ts';

const MAX_PROMPT_LENGTH = 32_000;
const MAX_KEY_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
const MAX_MODEL_LENGTH = 200;

interface ImageBody {
  prompt?: unknown;
  provider?: unknown;
  model?: unknown;
}

type Req = IncomingMessage & { body?: unknown };
type Res = ServerResponse;

/** An error that maps to a specific HTTP status + JSON body for the client. */
class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** The picker label a missing-key error concerns, e.g. "Image". */
  readonly model: string | undefined;
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

/** JSON body from Vercel's parser, or read it ourselves if it is not present. */
async function readBody(req: Req): Promise<ImageBody> {
  const pre = req.body;
  if (pre !== undefined && pre !== null) {
    if (typeof pre === 'object') return pre as ImageBody;
    if (typeof pre === 'string') {
      try {
        return JSON.parse(pre) as ImageBody;
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
    return JSON.parse(text) as ImageBody;
  } catch {
    return {};
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return 'The image could not be generated.';
}

/** Wraps a provider failure so the client receives the vendor's own status + message. */
function toUpstreamApiError(error: unknown): ApiError {
  const candidate = (error as { status?: unknown } | null)?.status;
  const status = typeof candidate === 'number' ? candidate : 502;
  const safe = status >= 400 && status <= 599 ? status : 502;
  const upstreamCode = error instanceof UpstreamError ? error.code : undefined;
  return new ApiError(safe, errorMessage(error), {
    code: 'upstream_error',
    ...(upstreamCode !== undefined ? { upstreamCode } : {}),
  });
}

export default async function handler(req: Req, res: Res): Promise<void> {
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { code: 'method_not_allowed', message: 'Use POST for /api/image.' });
    return;
  }

  try {
    const body = await readBody(req);

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (prompt === '') {
      throw new ApiError(400, '"prompt" is required and must be a non-empty string.', {
        code: 'bad_request',
      });
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw new ApiError(400, `"prompt" must be at most ${MAX_PROMPT_LENGTH} characters.`, {
        code: 'bad_request',
      });
    }

    const providerRaw = typeof body.provider === 'string' ? body.provider.trim() : '';
    if (providerRaw !== 'openai' && providerRaw !== 'gemini') {
      throw new ApiError(400, '"provider" must be "openai" or "gemini".', { code: 'bad_request' });
    }
    const provider: ImageBackend = providerRaw;

    const apiKey = (getHeader(req, 'x-provider-key') ?? '').trim();
    if (apiKey === '') {
      throw new ApiError(400, 'Add an API key for Image in Settings', {
        code: 'missing_api_key',
        // The client surfaces the missing key by this picker label.
        model: 'Image',
      });
    }
    if (apiKey.length >= MAX_KEY_LENGTH) {
      throw new ApiError(400, 'The API key header is too long.', { code: 'invalid_provider_config' });
    }

    let baseUrl: string | undefined;
    const overrideUrl = getHeader(req, 'x-provider-base-url');
    if (overrideUrl !== undefined && overrideUrl.trim() !== '') {
      const trimmed = overrideUrl.trim();
      if (trimmed.length > MAX_URL_LENGTH) {
        throw new ApiError(400, 'The base URL header is too long.', {
          code: 'invalid_provider_config',
        });
      }
      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw new ApiError(400, 'The base URL header must be a valid http(s) URL.', {
          code: 'invalid_provider_config',
        });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ApiError(400, 'The base URL header must use http or https.', {
          code: 'invalid_provider_config',
        });
      }
      baseUrl = trimmed.replace(/\/+$/, '');
    }

    const overrideModel = (getHeader(req, 'x-provider-model') ?? '').trim();
    if (overrideModel.length >= MAX_MODEL_LENGTH) {
      throw new ApiError(400, 'The model header is too long.', {
        code: 'invalid_provider_config',
      });
    }

    const abort = new AbortController();
    req.on('close', () => abort.abort());

    let result;
    try {
      result = await generateImage({
        prompt,
        provider,
        apiKey,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(overrideModel !== '' ? { model: overrideModel } : {}),
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        res.statusCode = 499;
        res.end();
        return;
      }
      throw toUpstreamApiError(error);
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        image: { dataUrl: result.dataUrl, mimeType: result.mimeType },
        provider: result.provider,
        model: result.model,
      }),
    );
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
    console.error('[api/image]', error);
    sendJson(res, 500, { code: 'internal_error', message: 'Internal server error' });
  }
}
