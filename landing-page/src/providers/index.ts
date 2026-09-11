import { config } from '../config.ts';
import { AnthropicProvider } from './anthropic.ts';
import { MockProvider } from './mock.ts';
import { OpenAICompatibleProvider } from './openai-compatible.ts';
import type { ChatProvider } from './types.ts';

export type { ChatMessage, ChatProvider, ChatRequest } from './types.ts';

export const PROVIDER_NAMES = ['mock', 'anthropic', 'openai-compatible'] as const;

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
      return new AnthropicProvider(apiKey);

    case 'openai-compatible':
      if (baseUrl === '') {
        throw new Error('AI_PROVIDER=openai-compatible requires AI_BASE_URL');
      }
      return new OpenAICompatibleProvider(baseUrl, apiKey);

    default:
      throw new Error(
        `Unknown AI_PROVIDER "${name}". Supported values: ${PROVIDER_NAMES.join(', ')}.`,
      );
  }
}

/** The single provider this process talks to, chosen once at boot. */
export const provider: ChatProvider = build();
