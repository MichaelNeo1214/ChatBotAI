/**
 * Text-to-image generation for the "Image" picker entry.
 *
 * Image generation is deliberately NOT part of the streaming chat adapter:
 * both APIs answer with JSON (a base64 image), not a token stream, so it gets
 * its own small module and endpoint (`/api/image`). Two backends are supported,
 * chosen by the caller from whichever BYOK key is configured:
 *
 *   - OpenAI Images API   POST {base}/images/generations   (GPT Image models)
 *   - Google Gemini       POST {base}/models/{id}:generateContent
 *
 * The returned image is always a self-contained `data:` URL (or, when a vendor
 * hands back a hosted URL instead of base64, that URL), so the browser can show
 * it and persist it without any server-side storage.
 */
import { UpstreamError, upstreamErrorInfo } from './errors.ts';

export type ImageBackend = 'openai' | 'gemini';

export interface ImageRequest {
  prompt: string;
  provider: ImageBackend;
  /** The caller's own key; never logged or persisted. */
  apiKey: string;
  /** Optional OpenAI-compatible base URL override. */
  baseUrl?: string;
  /** Optional model id override; falls back to the current GA default. */
  model?: string;
  signal?: AbortSignal;
}

export interface ImageResult {
  /** A `data:image/...;base64,...` URL, or a remote https URL. */
  dataUrl: string;
  mimeType: string;
  provider: ImageBackend;
  model: string;
}

/**
 * Current general-availability defaults. Both are the models the vendors
 * document as current in late 2026:
 *   - OpenAI retired the gpt-image-1 line in favour of gpt-image-2 (2026-04).
 *   - Google shut down gemini-2.5-flash-image on 2026-10-02; gemini-3.1-flash-image
 *     (Nano Banana 2) is the recommended replacement.
 * Both can be overridden per request with the X-Provider-Model header.
 */
const OPENAI_IMAGE_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_IMAGE_MODEL = 'gpt-image-2';
const GEMINI_IMAGE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image';

export const IMAGE_DEFAULTS = {
  openaiModel: OPENAI_IMAGE_MODEL,
  geminiModel: GEMINI_IMAGE_MODEL,
} as const;

function trimmedOr(value: string | undefined, fallback: string): string {
  return value !== undefined && value.trim() !== '' ? value.trim() : fallback;
}

/** Turns a non-2xx image response into an UpstreamError carrying the vendor's message. */
async function readError(response: Response): Promise<UpstreamError> {
  const text = await response.text().catch(() => '');
  const { message, code } = upstreamErrorInfo(response.status, response.statusText, text);
  return new UpstreamError(message, {
    status: response.status,
    ...(code !== undefined ? { code } : {}),
  });
}

async function generateOpenAI(request: ImageRequest): Promise<ImageResult> {
  const baseUrl = trimmedOr(request.baseUrl, OPENAI_IMAGE_BASE_URL).replace(/\/+$/, '');
  const model = trimmedOr(request.model, OPENAI_IMAGE_MODEL);

  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.apiKey}`,
    },
    signal: request.signal ?? null,
    body: JSON.stringify({ model, prompt: request.prompt, n: 1, size: '1024x1024' }),
  });

  if (!response.ok) throw await readError(response);

  const payload = (await response.json()) as {
    data?: { b64_json?: unknown; url?: unknown }[];
  };
  const first = payload.data?.[0];
  if (first && typeof first.b64_json === 'string' && first.b64_json !== '') {
    return {
      dataUrl: `data:image/png;base64,${first.b64_json}`,
      mimeType: 'image/png',
      provider: 'openai',
      model,
    };
  }
  if (first && typeof first.url === 'string' && first.url !== '') {
    return { dataUrl: first.url, mimeType: 'image/png', provider: 'openai', model };
  }

  throw new UpstreamError('The image provider returned no image.', { status: 502 });
}

interface GeminiInlineData {
  mimeType?: unknown;
  mime_type?: unknown;
  data?: unknown;
}

interface GeminiPart {
  text?: unknown;
  inlineData?: GeminiInlineData;
  inline_data?: GeminiInlineData;
}

/** Finds the first inline image part, tolerating both camelCase and snake_case. */
function findInlineImage(parts: GeminiPart[] | undefined): { mimeType: string; data: string } | null {
  if (parts === undefined) return null;
  for (const part of parts) {
    const inline = part.inlineData ?? part.inline_data;
    if (!inline) continue;
    const data = inline.data;
    if (typeof data !== 'string' || data === '') continue;
    const mime = typeof inline.mimeType === 'string' ? inline.mimeType : inline.mime_type;
    return { mimeType: typeof mime === 'string' && mime !== '' ? mime : 'image/png', data };
  }
  return null;
}

async function generateGemini(request: ImageRequest): Promise<ImageResult> {
  const baseUrl = trimmedOr(request.baseUrl, GEMINI_IMAGE_BASE_URL).replace(/\/+$/, '');
  const model = trimmedOr(request.model, GEMINI_IMAGE_MODEL);

  const response = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': request.apiKey,
    },
    signal: request.signal ?? null,
    body: JSON.stringify({ contents: [{ parts: [{ text: request.prompt }] }] }),
  });

  if (!response.ok) throw await readError(response);

  const payload = (await response.json()) as {
    candidates?: { content?: { parts?: GeminiPart[] } }[];
  };
  const parts = payload.candidates?.[0]?.content?.parts;

  const image = findInlineImage(parts);
  if (image) {
    return {
      dataUrl: `data:${image.mimeType};base64,${image.data}`,
      mimeType: image.mimeType,
      provider: 'gemini',
      model,
    };
  }

  // A refusal or a blocked prompt comes back as text with no image part.
  const text = (parts ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter((part) => part !== '')
    .join(' ')
    .trim();
  throw new UpstreamError(text !== '' ? text : 'The image provider returned no image.', {
    status: 502,
  });
}

/** Generates one image and returns it as an embeddable data URL. */
export async function generateImage(request: ImageRequest): Promise<ImageResult> {
  if (request.prompt.trim() === '') {
    throw new UpstreamError('A prompt is required to generate an image.', { status: 400 });
  }
  return request.provider === 'gemini' ? generateGemini(request) : generateOpenAI(request);
}
