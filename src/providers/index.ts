import { config } from '../config.ts';
import { badRequest } from '../middleware/errors.ts';
import { AnthropicProvider } from './anthropic.ts';
import { MockProvider } from './mock.ts';
import { OpenAICompatibleProvider } from './openai-compatible.ts';
import { DEFAULT_MODEL_LABEL, PROVIDER_PRESETS, isKnownModelLabel } from './presets.ts';
import type { ChatProvider } from './types.ts';

export type { ChatMessage, ChatProvider, ChatRequest } from './types.ts';
export { DEFAULT_MODEL_LABEL, PROVIDER_PRESETS } from './presets.ts';

export const PROVIDER_NAMES = ['mock', 'anthropic', 'openai-compatible'] as const;

const BYOK_KEY = 'X-Provider-Key';
const BYOK_BASE_URL = 'X-Provider-Base-Url';
const BYOK_MODEL = 'X-Provider-Model';

const MAX_API_KEY_LENGTH = 512;
const MAX_BASE_URL_LENGTH = 2048;
const MAX_MODEL_LENGTH = 200;
const MAX_LABEL_LENGTH = 100;

/** The subset of request headers the BYOK path reads. */
export interface ProviderHeaders {
  get(name: string): string | undefined;
}

/**
 * Express hands routes a plain object of headers, so reads fall back to a
 * case-insensitive lookup when there is no `get` method.
 */
function readHeader(source: unknown, name: string): string | undefined {
  const withGet = source as Partial<ProviderHeaders> | undefined;
  if (typeof withGet?.get === 'function') return withGet.get(name);

  const bag = source as Record<string, unknown> | undefined;
  if (bag === undefined || bag === null) return undefined;

  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(bag)) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
    return undefined;
  }
  return undefined;
}

/** Reads a header from either a Headers object or a plain headers bag. */
export function headerReader(source: unknown): ProviderHeaders {
  return { get: (name: string) => readHeader(source, name) };
}

function build(): ChatProvider {
  const { name, apiKey, baseUrl } = config.provider;

  switch (name) {
    case 'mock':
      return new MockProvider();

    case 'anthropic':
      if (apiKey === '') {
        console.warn(
          '[providers] AI_PROVIDER=anthropic but AI_API_KEY is empty — falling back to mock.',
        );
        return new MockProvider();
      }
      return new AnthropicProvider({ apiKey, model: config.provider.model });

    case 'openai-compatible':
      if (baseUrl === '') {
        throw new Error('AI_PROVIDER=openai-compatible requires AI_BASE_URL');
      }
      return new OpenAICompatibleProvider({
        baseUrl,
        apiKey,
        model: config.provider.model,
      });

    default:
      throw new Error(
        `Unknown AI_PROVIDER "${name}". Supported values: ${PROVIDER_NAMES.join(', ')}.`,
      );
  }
}

/** The single provider this process talks to, chosen once at boot. */
export const provider: ChatProvider = build();

/** The model label that means "use the server's provider", not a BYOK preset. */
export const isDefaultModelLabel = (label: string | undefined): boolean =>
  label === undefined || label === '' || label === DEFAULT_MODEL_LABEL;

/**
 * Maps a boot-time picker label to the server's configured model id, so the
 * existing AI_MODEL_MAP behaviour is unchanged. Unmapped labels fall back to
 * AI_MODEL.
 */
function resolveBootModel(label: string | undefined): string {
  if (label === undefined) return config.provider.model;
  return config.provider.modelMap[label] ?? config.provider.model;
}

function invalid(message: string, label: string): never {
  throw badRequest(message, { code: 'invalid_provider_config', extra: { model: label } });
}

/**
 * Reads and checks the BYOK headers for a request.
 *
 * The key is validated and handed to a provider instance; it is never logged,
 * never persisted, and never placed in an error message.
 */
function readByokOptions(label: string, headers: ProviderHeaders) {
  const preset = PROVIDER_PRESETS[label];
  if (preset === undefined) {
    throw badRequest(`Unknown model "${label}".`, { code: 'unknown_model' });
  }

  const apiKey = headers.get(BYOK_KEY);
  if (apiKey === undefined || apiKey.trim() === '') {
    throw badRequest(`Add an API key for ${label} in Settings`, {
      code: 'missing_api_key',
      extra: { model: label },
    });
  }
  if (apiKey.length >= MAX_API_KEY_LENGTH) {
    invalid('The API key header is too long.', label);
  }

  let baseUrl = preset.baseUrl;
  const overrideBaseUrl = headers.get(BYOK_BASE_URL);
  if (overrideBaseUrl !== undefined && overrideBaseUrl.trim() !== '') {
    const trimmed = overrideBaseUrl.trim();
    if (trimmed.length > MAX_BASE_URL_LENGTH) {
      invalid('The base URL header is too long.', label);
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      invalid('The base URL header must be a valid http(s) URL.', label);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      invalid('The base URL header must use http or https.', label);
    }
    baseUrl = trimmed.replace(/\/+$/, '');
  }

  const overrideModel = headers.get(BYOK_MODEL);
  let model = preset.model;
  if (overrideModel !== undefined && overrideModel.trim() !== '') {
    const trimmed = overrideModel.trim();
    if (trimmed.length >= MAX_MODEL_LENGTH) {
      invalid('The model header is too long.', label);
    }
    model = trimmed;
  }

  return { preset, apiKey, baseUrl, model };
}

/**
 * Chooses the provider for one chat request.
 *
 * The default label streams through the boot-time provider exactly as before.
 * Any other label is a BYOK preset: the caller's key builds a throwaway
 * provider instance that lives only for this request.
 */
export function resolveProviderForRequest(input: {
  modelLabel: string | undefined;
  headers: ProviderHeaders | unknown;
}): { provider: ChatProvider; model: string } {
  const { modelLabel } = input;
  const headers = headerReader(input.headers);

  if (isDefaultModelLabel(modelLabel)) {
    return { provider, model: resolveBootModel(modelLabel) };
  }

  const label = modelLabel as string;
  if (label.length > MAX_LABEL_LENGTH) {
    throw badRequest('Unknown model.', { code: 'unknown_model' });
  }
  if (!isKnownModelLabel(label)) {
    throw badRequest(`Unknown model "${label}".`, { code: 'unknown_model' });
  }

  const { preset, apiKey, baseUrl, model } = readByokOptions(label, headers);

  if (preset.adapter === 'anthropic') {
    return { provider: new AnthropicProvider({ apiKey, model }), model };
  }

  if (baseUrl === undefined) {
    // Unreachable for the shipped presets, but keeps the adapter honest.
    throw badRequest(`No base URL is configured for ${label}.`, {
      code: 'invalid_provider_config',
      extra: { model: label },
    });
  }

  return { provider: new OpenAICompatibleProvider({ baseUrl, apiKey, model }), model };
}
