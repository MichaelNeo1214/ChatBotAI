import { badRequest } from '../middleware/errors.ts';

/** The instructions every adapter sends when a conversation sets nothing. */
export const DEFAULT_SYSTEM_PROMPT =
  'You are ChatBot AI, a helpful assistant. Answer clearly and concisely. ' +
  'Use Markdown for structure and fenced code blocks for code.';

/** A prompt longer than this is almost certainly pasted content, not a persona. */
export const MAX_SYSTEM_PROMPT_LENGTH = 4_000;

export interface Personality {
  id: string;
  name: string;
  description: string;
  /** Full system prompt; replaces the default rather than extending it. */
  prompt: string;
}

const BASE = 'Use Markdown for structure and fenced code blocks for code.';

/**
 * Built-in personas the picker can offer. Each is a complete system prompt so
 * the model gets one consistent voice instead of two sets of instructions.
 */
export const PERSONALITIES: readonly Personality[] = [
  {
    id: 'default',
    name: 'ChatBot AI',
    description: 'Balanced, clear and concise.',
    prompt: DEFAULT_SYSTEM_PROMPT,
  },
  {
    id: 'concise',
    name: 'Concise',
    description: 'Short answers, no preamble.',
    prompt:
      'You are ChatBot AI. Answer in as few words as fully answer the question. ' +
      'No greetings, no restating the question, no closing remarks. ' + BASE,
  },
  {
    id: 'tutor',
    name: 'Tutor',
    description: 'Explains step by step and checks understanding.',
    prompt:
      'You are ChatBot AI acting as a patient tutor. Break explanations into ' +
      'small steps, define terms the first time you use them, give one worked ' +
      'example, and end with a short question that checks understanding. ' + BASE,
  },
  {
    id: 'coder',
    name: 'Coder',
    description: 'Code first, with brief explanations.',
    prompt:
      'You are ChatBot AI, a senior software engineer. Lead with working code, ' +
      'then explain only what is not obvious from reading it. Point out edge ' +
      'cases and pitfalls. Prefer the standard library over new dependencies. ' + BASE,
  },
  {
    id: 'creative',
    name: 'Creative',
    description: 'Playful and imaginative writing.',
    prompt:
      'You are ChatBot AI in a creative mood. Write with vivid imagery, varied ' +
      'rhythm and a light sense of humour. Offer an unexpected angle when asked ' +
      'for ideas. ' + BASE,
  },
];

export function findPersonality(id: string): Personality | undefined {
  return PERSONALITIES.find((personality) => personality.id === id);
}

/**
 * Reads a persona choice from a request body. Either `personality` (a built-in
 * id) or `systemPrompt` (free text) may be given, not both. Returns
 * `undefined` when neither is present, and `null` when the caller asked to
 * clear the prompt back to the default.
 */
export function readSystemPrompt(body: unknown): string | null | undefined {
  const { systemPrompt, personality } = (body ?? {}) as Record<string, unknown>;
  const hasPrompt = systemPrompt !== undefined;
  const hasPersonality = personality !== undefined;

  if (hasPrompt && hasPersonality) {
    throw badRequest('Send either "systemPrompt" or "personality", not both');
  }

  if (hasPersonality) {
    if (personality === null) return null;
    if (typeof personality !== 'string') {
      throw badRequest('"personality" must be a string');
    }
    const found = findPersonality(personality);
    if (!found) {
      throw badRequest(`Unknown personality "${personality}"`, {
        code: 'unknown_personality',
        extra: { personality },
      });
    }
    // The default persona is stored as "no prompt" so it tracks future edits.
    return found.id === 'default' ? null : found.prompt;
  }

  if (hasPrompt) {
    if (systemPrompt === null) return null;
    if (typeof systemPrompt !== 'string') {
      throw badRequest('"systemPrompt" must be a string');
    }
    const trimmed = systemPrompt.trim();
    if (trimmed === '') return null;
    if (trimmed.length > MAX_SYSTEM_PROMPT_LENGTH) {
      throw badRequest(`"systemPrompt" must be at most ${MAX_SYSTEM_PROMPT_LENGTH} characters`);
    }
    return trimmed;
  }

  return undefined;
}
