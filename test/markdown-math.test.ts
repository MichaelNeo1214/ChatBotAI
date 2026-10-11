import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/** The surface js/markdown-math.js exposes on the global object. */
interface MathModule {
  BLOCK_PH: string;
  INLINE_PH: string;
  ready(): boolean;
  render(tex: string, displayMode: boolean): string;
  extractBlocks(text: string, sink: string[]): string;
  extractInline(text: string, sink: string[]): string;
  isBlockPlaceholder(line: string): boolean;
  blockIndex(line: string): number;
  restore(html: string, blocks: string[], inlines: string[]): string;
}

/**
 * The math delimiter rules.
 *
 * These live in a browser IIFE with no exports, so the file is evaluated here
 * directly. That is deliberate: the whole point of extracting
 * js/markdown-math.js was to make these regexes testable instead of buried in
 * a 4,000-line file. The module attaches itself to the global object, which
 * Node's globalThis is, so it can be loaded by evaluating the source as-is.
 */
function loadMathModule(): MathModule {
  const source = readFileSync(path.join(process.cwd(), 'js', 'markdown-math.js'), 'utf8');
  const scope = globalThis as { ChatBotMath?: MathModule };
  if (scope.ChatBotMath !== undefined) return scope.ChatBotMath;

  new Function(source)();

  const loaded = scope.ChatBotMath;
  if (loaded === undefined) throw new Error('js/markdown-math.js did not export ChatBotMath');
  return loaded;
}

const math = loadMathModule();

describe('math extraction', () => {
  describe('display math', () => {
    it('lifts $$...$$ out and leaves a placeholder', () => {
      const sink: string[] = [];
      const out = math.extractBlocks('before\n$$\\frac{a}{b}$$\nafter', sink);

      assert.deepEqual(sink, ['\\frac{a}{b}']);
      assert.ok(math.isBlockPlaceholder(math.BLOCK_PH + '0\u0003'));
      assert.match(out, /before/);
      assert.match(out, /after/);
      assert.doesNotMatch(out, /\$\$/);
    });

    it('collects several expressions in order', () => {
    const sink: string[] = [];
    math.extractBlocks('$$a$$\n$$b$$', sink);
    assert.deepEqual(sink, ['a', 'b']);
  });

  it('spans multiple lines', () => {
    const sink: string[] = [];
    math.extractBlocks('$$\n\\begin{align}\nx &= 1 \\\\\ny &= 2\n\\end{align}\n$$', sink);
    assert.equal(sink.length, 1);
    assert.match(sink[0] ?? '', /begin\{align\}/);
  });

  it('preserves the & alignment character intact', () => {
    // The whole reason math is extracted before escapeHtml: an escaped "&"
    // would silently break every aligned environment.
    const sink: string[] = [];
    math.extractBlocks('$$a &= b$$', sink);
    assert.equal(sink[0], 'a &= b');
    assert.match(sink[0], /&/, 'the raw ampersand must survive extraction');
  });

it('consumes a whitespace-only $$ $$ without emitting a block', () => {
      const sink: string[] = [];
      const out = math.extractBlocks('a $$ $$ b', sink);
      assert.deepEqual(sink, []);
      assert.equal(out, 'a  b');
    });

    it('leaves a bare $$$$ alone rather than eating it', () => {
      // Zero characters between the delimiters cannot match, so nothing is
      // consumed — the literal text survives instead of vanishing.
      const sink: string[] = [];
      const input = 'a $$$$ b';
      assert.equal(math.extractBlocks(input, sink), input);
      assert.deepEqual(sink, []);
    });

  it('does not treat inline $x$ as a display block', () => {
    const sink: string[] = [];
    math.extractBlocks('cost is $5 today', sink);
    assert.deepEqual(sink, []);
  });
  });

  describe('inline math', () => {
    it('lifts a simple inline expression', () => {
      const sink: string[] = [];
      const out = math.extractInline('the value $x^2$ grows', sink);
      assert.deepEqual(sink, ['x^2']);
      assert.match(out, /the value/);
      assert.match(out, /grows/);
    });

    it('leaves currency alone', () => {
      for (const input of ['costs $5', 'about $12.50 total', 'pay $.99 now']) {
        const sink: string[] = [];
        const out = math.extractInline(input, sink);
        assert.deepEqual(sink, [], `"${input}" must not be read as maths`);
        assert.equal(out, input);
      }
    });

    it('ignores a span padded with whitespace', () => {
      const sink: string[] = [];
      math.extractInline('a $ x $ b', sink);
      assert.deepEqual(sink, []);
    });

    it('ignores an unclosed dollar', () => {
      const sink: string[] = [];
      const input = 'costs $5 and more';
      assert.equal(math.extractInline(input, sink), input);
      assert.deepEqual(sink, []);
    });

    it('does not match across a newline', () => {
      const sink: string[] = [];
      math.extractInline('a $x\ny$ b', sink);
      assert.deepEqual(sink, []);
    });

    it('collects several inline expressions in order', () => {
      const sink: string[] = [];
      math.extractInline('$a$ then $b$', sink);
      assert.deepEqual(sink, ['a', 'b']);
    });
  });

  describe('rendering', () => {
    it('falls back to escaped source when KaTeX is absent', () => {
      assert.equal(math.ready(), false, 'the stub global has no KaTeX');
      const html = math.render('<script>alert(1)</script>', true);

      assert.match(html, /^<code class="math-raw">/);
      assert.doesNotMatch(html, /<script>/);
      assert.match(html, /&lt;script&gt;/);
    });

    it('restores block and inline placeholders', () => {
      const rendered = math.restore(
        math.BLOCK_PH + '0\u0003 and ' + math.INLINE_PH + '0\u0002',
        ['a &= b'],
        ['x^2'],
      );
      assert.match(rendered, /a &amp;= b|math-raw/);
      assert.doesNotMatch(rendered, /\u0003|\u0002/, 'no placeholder may survive');
    });

    it('drops a placeholder with no matching sink entry', () => {
      const rendered = math.restore(math.BLOCK_PH + '9\u0003', [], []);
      assert.equal(rendered, '');
    });
  });
});