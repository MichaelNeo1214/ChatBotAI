import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * The image lightbox.
 *
 * Only its pure decision logic is exercised here — zoom clamping and whether a
 * source is safe to display. The DOM wiring is covered by the smoke test in
 * static.test.ts, which asserts the module is loaded and precached.
 */
interface Lightbox {
  isSafeSource(src: unknown): boolean;
  MIN_ZOOM: number;
  MAX_ZOOM: number;
}

function loadLightbox(): Lightbox {
  const host = globalThis as Record<string, unknown>;
  const hadWindow = 'window' in host;
  const previousWindow = host.window;

  // The module attaches keydown and resize listeners at load time, so the
  // stub needs them or evaluating the file throws before it exports.
  const stub = {
    document: {
      addEventListener() {},
      createElement: () => ({
        classList: { add() {}, toggle() {} },
        style: {},
        setAttribute() {},
        appendChild() {},
        addEventListener() {},
        removeAttribute() {},
        querySelector: () => null,
      }),
    },
    addEventListener() {},
  };
  host.window = stub;
  delete host.ChatBotLightbox;

  try {
    const source = readFileSync(path.join(process.cwd(), 'js', 'lightbox.js'), 'utf8');
    new Function(source)();
    return (stub as Record<string, unknown>).ChatBotLightbox as Lightbox;
  } finally {
    if (hadWindow) host.window = previousWindow;
    else delete host.window;
    delete host.ChatBotLightbox;
  }
}

describe('lightbox', () => {
  const lb = () => loadLightbox();

  it('accepts only data:image sources', () => {
    const api = lb();
    assert.equal(api.isSafeSource('data:image/png;base64,iVBOR'), true);
    assert.equal(api.isSafeSource('data:image/jpeg;base64,/9j/'), true);
    assert.equal(api.isSafeSource('data:image/webp;base64,UklGR'), true);
  });

  it('refuses anything that could load a remote resource or a document', () => {
    // A crafted src on a shared view would be a way to exfiltrate or to render
    // something other than the image the app produced.
    const api = lb();
    const hostile = [
      'https://evil.example/pixel.png',
      'http://127.0.0.1:3000/api/health',
      '/api/health',
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:application/pdf;base64,JVBER',
      '',
      null,
      undefined,
      42,
      {},
    ];
    for (const src of hostile) {
      assert.equal(api.isSafeSource(src), false, `${String(src)} must be refused`);
    }
  });

  it('exposes sane zoom bounds', () => {
    const api = lb();
    assert.ok(api.MIN_ZOOM > 0 && api.MIN_ZOOM < 1, 'must be able to zoom out below 1:1');
    assert.ok(api.MAX_ZOOM >= 2, 'must be able to zoom in at least 2x');
    assert.ok(api.MIN_ZOOM < api.MAX_ZOOM);
  });
});

describe('image and title wiring', () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');

  it('registers a paste listener on the composer', () => {
    const script = read('js/script.js');
    assert.match(script, /chatInput\.addEventListener\('paste'/);
    assert.match(script, /clipboard\.items/);
    // Only an image-only paste is swallowed, so ordinary text pasting keeps
    // working through the composer.
    assert.match(script, /if \(files\.length === 0\) return;/);
    assert.match(script, /e\.preventDefault\(\);\s*\r?\n\s*for \(let i = 0; i < files\.length/);
  });

  it('delegates the lightbox rather than binding per image', () => {
    // Replies re-render on every streamed chunk, so a per-image listener would
    // accumulate on the same node and fire once per attachment.
    const script = read('js/script.js');
    assert.match(script, /ChatBotLightbox\.delegate\(messagesWrapper\)/);
    assert.doesNotMatch(script, /addEventListener\('click'[^)]*message-image/);
  });

  it('clears the smart-title guard when the conversation changes', () => {
    // Without this only the first chat a user ever started would be titled.
    const script = read('js/script.js');
    assert.match(script, /function resetSmartTitleGuard\(\)/);
    assert.match(script, /setActiveConversationId[\s\S]{0,400}resetSmartTitleGuard/);
  });

  it('carries images through the cloud-sync round trip', () => {
    const script = read('js/script.js');
    // Outbound: buildSessionData must include the image field.
    assert.match(script, /record\.image = m\.image;/);
    // Inbound: the renderer reads `content`, which is what the cloud stores.
    assert.match(script, /typeof m\.content === 'string'/);
    assert.match(script, /\{ image: m\.image \}/);
  });

  it('loads the new modules in index.html and precaches them', () => {
    const html = read('index.html');
    const sw = read('sw.js');
    for (const module of ['js/lightbox.js', 'js/title.js']) {
      assert.ok(html.includes(`src="${module}"`), `index.html must load ${module}`);
      // sw.js records precache entries as root-absolute paths.
      assert.ok(sw.includes(`'/${module}'`), `sw.js must precache /${module}`);
    }
  });

  it('declares the title function in vercel.json and the file exists', () => {
    const vercel = JSON.parse(read('vercel.json')) as { functions?: Record<string, unknown> };
    assert.ok('api/title.ts' in (vercel.functions ?? {}), 'api/title.ts must be declared');
    assert.ok(readFileSync(path.join(process.cwd(), 'api', 'title.ts'), 'utf8').length > 0);
  });
});