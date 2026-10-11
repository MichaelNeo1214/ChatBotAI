import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseChatParameters } from '../src/providers/parameters.ts';
import type { ChatParameters } from '../src/providers/types.ts';

/**
 * Validation for the per-request generation parameters.
 *
 * These come from sliders in the settings modal, but the values arrive over the
 * wire, so they are treated as untrusted. Out-of-range values are rejected
 * rather than clamped: a slider cannot produce them, and silently changing the
 * request hides the mistake.
 */
describe('chat parameter validation', () => {
  it('accepts an absent parameters object', () => {
    for (const input of [undefined, null]) {
      const result = parseChatParameters(input);
      assert.equal(result.ok, true);
      assert.deepEqual(result.value, {});
    }
  });

  it('accepts a full set of parameters', () => {
    const result = parseChatParameters({
      systemPrompt: 'Be terse.',
      temperature: 0.4,
      topP: 0.9,
      maxTokens: 2048,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
      systemPrompt: 'Be terse.',
      temperature: 0.4,
      topP: 0.9,
      maxTokens: 2048,
    } satisfies ChatParameters);
  });

  it('omits fields that were not supplied, so provider defaults still apply', () => {
    const result = parseChatParameters({ temperature: 0 });
    assert.equal(result.ok, true);
    // 0 is falsy but valid — it must survive, not be dropped as "empty".
    assert.deepEqual(result.value, { temperature: 0 });
    assert.ok(!('topP' in result.value));
    assert.ok(!('maxTokens' in result.value));
    assert.ok(!('systemPrompt' in result.value));
  });

  it('rejects a non-object parameters field', () => {
    for (const input of ['nope', 42, [1, 2]]) {
      const result = parseChatParameters(input);
      assert.equal(result.ok, false, `${JSON.stringify(input)} should be rejected`);
      assert.match(result.error ?? '', /must be an object/);
    }
  });

  describe('systemPrompt', () => {
    it('rejects a non-string', () => {
      const result = parseChatParameters({ systemPrompt: 42 });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /systemPrompt/);
    });

    it('rejects an over-long prompt', () => {
      const result = parseChatParameters({ systemPrompt: 'x'.repeat(8001) });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /at most 8000/);
    });

    it('accepts one exactly at the limit', () => {
      const result = parseChatParameters({ systemPrompt: 'x'.repeat(8000) });
      assert.equal(result.ok, true);
    });
  });

  describe('temperature', () => {
    it('accepts the inclusive bounds', () => {
      for (const value of [0, 1, 2]) {
        assert.equal(parseChatParameters({ temperature: value }).ok, true, `${value} should pass`);
      }
    });

    it('rejects values outside 0..2', () => {
      for (const value of [-0.1, 2.1, 100]) {
        const result = parseChatParameters({ temperature: value });
        assert.equal(result.ok, false, `${value} should be rejected`);
        assert.match(result.error ?? '', /between 0 and 2/);
      }
    });

    it('rejects a non-numeric value', () => {
      const result = parseChatParameters({ temperature: 'hot' });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /between 0 and 2/);
    });

    it('rejects NaN and Infinity', () => {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(parseChatParameters({ temperature: value }).ok, false);
      }
    });
  });

  describe('topP', () => {
    it('accepts the inclusive upper bound', () => {
      assert.equal(parseChatParameters({ topP: 1 }).ok, true);
    });

    it('rejects zero and negatives, which are not meaningful nucleus sampling', () => {
      for (const value of [0, -0.5, 1.5]) {
        const result = parseChatParameters({ topP: value });
        assert.equal(result.ok, false, `${value} should be rejected`);
        assert.match(result.error ?? '', /topP/);
      }
    });

    it('also accepts the snake_case spelling', () => {
      const result = parseChatParameters({ top_p: 0.8 });
      assert.equal(result.ok, true);
      assert.deepEqual(result.value, { topP: 0.8 });
    });
  });

  describe('maxTokens', () => {
    it('accepts a whole number in range', () => {
      assert.equal(parseChatParameters({ maxTokens: 4096 }).ok, true);
    });

    it('rejects a fractional value', () => {
      const result = parseChatParameters({ maxTokens: 100.5 });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /whole number/);
    });

    it('rejects zero and negatives', () => {
      for (const value of [0, -1]) {
        assert.equal(parseChatParameters({ maxTokens: value }).ok, false);
      }
    });

    it('rejects an absurd cap', () => {
      const result = parseChatParameters({ maxTokens: 1_000_000 });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /between 1 and 64000/);
    });

    it('also accepts the snake_case spelling', () => {
      const result = parseChatParameters({ max_tokens: 512 });
      assert.equal(result.ok, true);
      assert.deepEqual(result.value, { maxTokens: 512 });
    });
  });

  it('accepts numeric strings, which is what a form control may send', () => {
    const result = parseChatParameters({ temperature: '0.7', maxTokens: '1024' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { temperature: 0.7, maxTokens: 1024 });
  });
});

/**
 * What actually goes over the wire.
 *
 * Validating the parameters is only half the job — they have to reach the
 * upstream request. The outgoing body is captured by stubbing fetch, which is
 * also the only way to assert the *absence* of fields a given gateway would
 * reject: a free endpoint that does not understand `reasoning` or `top_p`
 * fails the whole turn.
 */
describe('parameter passthrough to the upstream body', () => {
  const originalFetch = globalThis.fetch;

  interface Captured {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }

  async function capture(body: Record<string, unknown>, options: Record<string, unknown> = {}) {
    const captured: Captured[] = [];

    globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
      captured.push({
        url: String(url),
        headers: (init.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      // A minimal well-formed SSE response so streamChat terminates cleanly.
      const sse =
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' + 'data: [DONE]\n\n';
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    try {
      const { OpenAICompatibleProvider } = await import('../src/providers/openai-compatible.ts');
      const provider = new OpenAICompatibleProvider({
        baseUrl: 'https://example.test/v1',
        apiKey: 'k',
        model: 'openrouter/free',
        ...options,
      });

      const params = parseChatParameters(body.parameters ?? undefined);
      assert.equal(params.ok, true, `test fixture should validate: ${params.error}`);

      const chunks: string[] = [];
      for await (const chunk of provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        ...(Object.keys(params.value).length > 0 ? { parameters: params.value } : {}),
      })) {
        chunks.push(chunk);
      }

      assert.equal(chunks.join(''), 'ok');
      assert.equal(captured.length, 1);
      return captured[0]!;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it('sends the system prompt in place of the built-in one', async () => {
    const sent = await capture({ parameters: { systemPrompt: 'Answer only in haiku.' } });
    const system = (sent.body.messages as { role: string; content: string }[])[0]!;
    assert.equal(system.role, 'system');
    assert.equal(system.content, 'Answer only in haiku.');
  });

  it('maps topP onto top_p and maxTokens onto max_completion_tokens', async () => {
    const sent = await capture({ parameters: { topP: 0.85, maxTokens: 512, temperature: 0.3 } });

    assert.equal(sent.body.top_p, 0.85);
    assert.equal(sent.body.max_completion_tokens, 512);
    assert.equal(sent.body.temperature, 0.3);
    // The old OpenAI name is what reasoning models reject.
    assert.ok(!('max_tokens' in sent.body), 'must not send the legacy max_tokens field');
  });

  it('omits every parameter that was not supplied', async () => {
    const sent = await capture({});

    for (const field of ['temperature', 'top_p', 'max_completion_tokens', 'max_tokens', 'reasoning']) {
      assert.ok(!(field in sent.body), `${field} must be absent so provider defaults apply`);
    }
  });

  it('omits reasoning unless an effort was configured', async () => {
    const withoutEffort = await capture({ parameters: { temperature: 0.5 } });
    assert.ok(!('reasoning' in withoutEffort.body));

    const withEffort = await capture({ parameters: { temperature: 0.5 } }, { reasoningEffort: 'high' });
    assert.deepEqual(withEffort.body.reasoning, { effort: 'high' });
  });

  it('sends a temperature of 0 rather than dropping it as falsy', async () => {
    const sent = await capture({ parameters: { temperature: 0 } });
    assert.equal(sent.body.temperature, 0);
  });

  it('hits the configured base URL', async () => {
    const sent = await capture({});
    assert.equal(sent.url, 'https://example.test/v1/chat/completions');
    assert.equal(sent.body.model, 'openrouter/free');
    assert.equal(sent.body.stream, true);
  });
});
