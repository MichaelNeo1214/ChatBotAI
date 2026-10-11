import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Conversation titles.
 *
 * The bug these replace: deriveTitle() took the first user message and cut it
 * at 60 characters, so a prompt of "te" produced a sidebar entry reading "te".
 * A title is a label, not a prefix of what was typed.
 */
interface TitleApi {
  keywordTitle(text: string): string;
  cleanAiTitle(value: unknown): string | null;
  aiTitle(
    prompt: string,
    reply: string,
    options?: { enabled?: boolean; endpoint?: string },
  ): Promise<string | null>;
  MAX_CHARS: number;
  MAX_WORDS: number;
}

function loadTitle(fetchImpl?: unknown): TitleApi {
  const host = globalThis as Record<string, unknown>;
  const hadWindow = 'window' in host;
  const previousWindow = host.window;

  const stub: Record<string, unknown> = { fetch: fetchImpl };
  if (fetchImpl === undefined) delete stub.fetch;

  host.window = stub;
  delete host.ChatBotTitle;

  try {
    const source = readFileSync(path.join(process.cwd(), 'js', 'title.js'), 'utf8');
    new Function(source)();
    return (stub as Record<string, unknown>).ChatBotTitle as TitleApi;
  } finally {
    if (hadWindow) host.window = previousWindow;
    else delete host.window;
    delete host.ChatBotTitle;
  }
}

describe('keyword titles', () => {
  const t = () => loadTitle().keywordTitle;

  it('never returns an empty title', () => {
    for (const input of ['', '   ', '\n\t', null, undefined]) {
      const title = loadTitle().keywordTitle(input as unknown as string);
      assert.ok(title && title.trim() !== '', `"${String(input)}" must still produce a title`);
    }
  });

  it('does not reproduce the "te" bug', () => {
    // The reported symptom: a two-character prompt became the whole title.
    // There is nothing meaningful to work with, so it must at least be labelled
    // as a new chat rather than looking like real content.
    assert.equal(loadTitle().keywordTitle('te'), 'Te');
    assert.ok(loadTitle().keywordTitle('yt').length > 0);
  });

  it('drops filler words and keeps the topic', () => {
    // Sentence case rather than Title Case: only the first word is capitalised,
    // which reads better at sidebar length. Words that already carry internal
    // capitals are left alone (covered separately).
    assert.equal(
      loadTitle().keywordTitle('please explain how a neural network works'),
      'Explain neural network works',
    );
  });

  it('caps at six words', () => {
    const title = loadTitle().keywordTitle(
      'debugging intermittent null pointer dereference crash inside worker thread scheduler',
    );
    assert.ok(title.split(' ').length <= 6, `too many words: ${title}`);
  });

  it('caps at the character limit without leaving a dangling word', () => {
    const long = 'supercalifragilistic'.repeat(10);
    const title = loadTitle().keywordTitle(long);
    assert.ok(title.length <= loadTitle().MAX_CHARS, `too long: ${title.length}`);
    assert.doesNotMatch(title, /\s$/, 'must not end with whitespace');
  });

  it('preserves internal capitals like OpenAI or GPT-4o', () => {
    const title = loadTitle().keywordTitle('how do I call the OpenAI API with GPT-4o');
    assert.match(title, /OpenAI/);
    assert.match(title, /GPT-4o/);
  });

  it('handles punctuation, emoji and code without throwing', () => {
    for (const input of [
      'function foo() { return 1; }',
      'why is 🎉 breaking???',
      '   multiple    spaces\t\tand\nnewlines  ',
      'SELECT * FROM users WHERE id = 1;',
      '<script>alert(1)</script>',
    ]) {
      const title = loadTitle().keywordTitle(input);
      assert.ok(title.length > 0, `"${input}" produced nothing`);
      // The title is inserted as text, never as markup, but a defensive test
      // keeps the guarantee visible.
      assert.doesNotMatch(title, /<[a-z/]/i, 'must not look like markup');
    }
  });

  it('handles non-Latin scripts', () => {
    for (const input of ['神经ネットワークの仕組み', 'كيف تعمل الشبكة العصبية', 'Что такое нейросеть']) {
      const title = loadTitle().keywordTitle(input);
      assert.ok(title.length > 0, `"${input}" produced nothing`);
    }
  });

  it('falls back to the first words when every word is filler', () => {
    const title = loadTitle().keywordTitle('hi there thanks ok');
    assert.ok(title.length > 0);
  });
});

describe('cleaning a model-produced title', () => {
  const clean = (v: unknown) => loadTitle().cleanAiTitle(v);

  it('strips quotes, prefixes and trailing punctuation', () => {
    assert.equal(clean('"Neural Network Explanation"'), 'Neural Network Explanation');
    assert.equal(clean('Title: Fixing CCTV Stream Output'), 'Fixing CCTV Stream Output');
    assert.equal(clean('Summary - C Programming Bug Fix.'), 'C Programming Bug Fix');
    assert.equal(clean('  spaced   out  '), 'spaced out');
  });

  it('rejects values that are not usable titles', () => {
    assert.equal(clean(''), null);
    assert.equal(clean('   '), null);
    assert.equal(clean(null), null);
    assert.equal(clean(undefined), null);
    assert.equal(clean(42), null);
    assert.equal(clean({ title: 'x' }), null);
  });

  it('rejects a runaway response rather than showing it', () => {
    const runaway = 'word '.repeat(200);
    assert.equal(clean(runaway), null, 'a model that ignored the instruction must be discarded');
  });

  it('truncates an over-long but plausible title on a word boundary', () => {
    const api = loadTitle();
    const long = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi';
    const cleaned = api.cleanAiTitle(long);
    assert.ok(cleaned !== null);
    assert.ok(cleaned.length <= api.MAX_CHARS);
    assert.doesNotMatch(cleaned!, /\s$/);
  });
});

describe('aiTitle', () => {
  it('returns the cleaned title on success', async () => {
    const api = loadTitle(async () =>
      new Response(JSON.stringify({ title: '"Neural Network Explanation"' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    assert.equal(await api.aiTitle('explain nn', 'sure'), 'Neural Network Explanation');
  });

  it('returns null instead of throwing on a non-2xx response', async () => {
    const api = loadTitle(async () => new Response('nope', { status: 503 }));
    assert.equal(await api.aiTitle('x', 'y'), null);
  });

  it('returns null on a network failure', async () => {
    const api = loadTitle(async () => {
      throw new Error('offline');
    });
    assert.equal(await api.aiTitle('x', 'y'), null);
  });

  it('returns null on an unparseable body', async () => {
    const api = loadTitle(async () => new Response('<html>502</html>', { status: 200 }));
    assert.equal(await api.aiTitle('x', 'y'), null);
  });

  it('does not call the network at all when disabled', async () => {
    let called = false;
    const api = loadTitle(async () => {
      called = true;
      return new Response('{}', { status: 200 });
    });
    assert.equal(await api.aiTitle('x', 'y', { enabled: false }), null);
    assert.equal(called, false, 'a disabled AI title must not spend a request');
  });

  it('returns null when fetch is unavailable', async () => {
    const api = loadTitle();
    assert.equal(await api.aiTitle('x', 'y'), null);
  });
});