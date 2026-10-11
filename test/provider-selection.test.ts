import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * Boot-time provider selection.
 *
 * src/config.ts reads process.env once at import time, so each scenario has to
 * run in its own process. That is what `node -e` gives us: a clean import of
 * the real module under a controlled environment.
 */
const CONFIG_MODULE = pathToFileURL(path.join(process.cwd(), 'src', 'config.ts')).href;

interface ResolvedProvider {
  name: string;
  baseUrl: string;
  model: string;
  reasoningEffort: string | undefined;
  modelMap: Record<string, string>;
}

/** Imports src/config.ts in a child process and returns its provider block. */
function resolveProvider(env: Record<string, string>): ResolvedProvider {
  const script = `
    import { config } from ${JSON.stringify(CONFIG_MODULE)};
    process.stdout.write(JSON.stringify(config.provider));
  `;
  const out = execFileSync(process.execPath, ['--experimental-strip-types', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_PATH: ':memory:',
      // Start from a clean slate so the developer's own .env cannot leak in.
      AI_PROVIDER: '',
      AI_API_KEY: '',
      AI_MODEL: '',
      AI_BASE_URL: '',
      AI_MODEL_MAP: '',
      AI_REASONING_EFFORT: '',
      ...env,
    },
    encoding: 'utf8',
  });
  return JSON.parse(out) as ResolvedProvider;
}

describe('provider auto-selection', () => {
  it('serves the free tier when only a key is set', () => {
    // This is the production shape: one AI_API_KEY in Vercel, nothing else.
    const provider = resolveProvider({ AI_API_KEY: 'sk-or-v1-test' });
    assert.equal(provider.name, 'openai-compatible');
    assert.equal(provider.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(provider.model, 'stealth/space-bunny-alpha');
  });

  it('falls back to mock when there is no key at all', () => {
    // A fresh clone with no .env must still run instead of 401-ing every turn.
    const provider = resolveProvider({});
    assert.equal(provider.name, 'mock');
  });

  it('respects an explicit provider over the key heuristic', () => {
    const provider = resolveProvider({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'sk-ant-x' });
    assert.equal(provider.name, 'anthropic');
  });

  it('keeps mock when a key is set but the provider is pinned to it', () => {
    const provider = resolveProvider({ AI_PROVIDER: 'mock', AI_API_KEY: 'sk-or-v1-test' });
    assert.equal(provider.name, 'mock');
  });

  it('strips a trailing slash from the base URL', () => {
    const provider = resolveProvider({
      AI_PROVIDER: 'openai-compatible',
      AI_API_KEY: 'k',
      AI_BASE_URL: 'https://example.test/v1///',
    });
    assert.equal(provider.baseUrl, 'https://example.test/v1');
  });

  it('parses a reasoning effort', () => {
    const provider = resolveProvider({ AI_API_KEY: 'k', AI_REASONING_EFFORT: 'high' });
    assert.equal(provider.reasoningEffort, 'high');
  });

  it('leaves the reasoning effort unset when blank', () => {
    // Omitted rather than sent, because a gateway that does not know the field
    // rejects the entire request.
    const provider = resolveProvider({ AI_API_KEY: 'k', AI_REASONING_EFFORT: '' });
    assert.equal(provider.reasoningEffort, undefined);
  });

  it('rejects an invalid reasoning effort rather than sending it', () => {
    assert.throws(
      () => resolveProvider({ AI_API_KEY: 'k', AI_REASONING_EFFORT: 'turbo' }),
      /AI_REASONING_EFFORT/,
    );
  });

  it('rejects a malformed AI_MODEL_MAP', () => {
    assert.throws(
      () => resolveProvider({ AI_API_KEY: 'k', AI_MODEL_MAP: 'not json' }),
      /AI_MODEL_MAP/,
    );
  });

  it('maps picker labels to model ids', () => {
    const provider = resolveProvider({
      AI_API_KEY: 'k',
      AI_MODEL_MAP: '{"GPT-4o":"openai/gpt-4o"}',
    });
    assert.deepEqual(provider.modelMap, { 'GPT-4o': 'openai/gpt-4o' });
  });
});