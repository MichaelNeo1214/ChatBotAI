import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const html = read('index.html');
const scriptJs = read('js/script.js');
const authHtml = read('components/auth/signup.html');

/** Every id attribute in a document. */
function idsOf(source: string): string[] {
  return [...source.matchAll(/\sid="([A-Za-z0-9_:.-]+)"/g)].map((m) => m[1] ?? '');
}

describe('element ids are unique', () => {
  // Regression: "Delete account" appeared in both the Account panel and the
  // Data & privacy panel with the same id. getElementById returns only the
  // first match, so the second button was never bound and did nothing when
  // clicked - a control that looked live and was inert.
  for (const [name, source] of [
    ['index.html', html],
    ['components/auth/signup.html', authHtml],
  ] as const) {
    it(`${name} has no duplicate ids`, () => {
      const seen = new Map<string, number>();
      for (const id of idsOf(source)) seen.set(id, (seen.get(id) ?? 0) + 1);
      const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`);
      assert.deepEqual(dupes, [], `${name} has duplicate ids: ${dupes.join(', ')}`);
    });
  }
});

describe('every button is bound to something', () => {
  it('the privacy delete button is wired', () => {
    assert.match(html, /id="btnDeleteAccountPrivacy"/, 'index.html');
    assert.match(scriptJs, /bind\('btnDeleteAccountPrivacy'/, 'js/script.js');
  });

  it('the account delete button is still wired', () => {
    assert.match(html, /id="btnDeleteAccount"/, 'index.html');
    assert.match(scriptJs, /bind\('btnDeleteAccount'/, 'js/script.js');
  });

  it('no control is left with an id nothing references', () => {
    const scripts = ['script.js', 'settings.js', 'ui.js', 'title.js', 'lightbox.js', 'share.js', 'voice.js']
      .map((f) => read(`js/${f}`))
      .join('\n');

    // Ids addressed only through data-* attributes or a captured local are
    // legitimately not looked up by name.
    const exempt = new Set(['main', 'settingsModal', 'profileTitle', 'keyAlertTitle']);

    const orphans = [...new Set(idsOf(html))]
      .filter((id) => !exempt.has(id))
      .filter((id) => {
        const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`'${esc}'|"${esc}"|#${esc}`).test(scripts)) return false;
        if (new RegExp(`data-[a-z-]+="${esc}"`).test(html)) return false;
        return true;
      });

    assert.deepEqual(orphans, [], `controls wired to nothing: ${orphans.join(', ')}`);
  });
});

describe('form controls are labelled', () => {
  it('every input has a placeholder or an associated label', () => {
    // A field with neither is invisible to a screen reader.
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
    const unlabelled = inputs.filter(
      (tag) =>
        !/aria-label=/.test(tag) &&
        !/placeholder=/.test(tag) &&
        !/\sid="[^"]+"/.test(tag) &&
        !/type="(hidden|checkbox|radio)"/.test(tag),
    );
    assert.deepEqual(unlabelled, [], `inputs with no accessible name: ${unlabelled.join(' | ')}`);
  });

  it('icon-only buttons carry an aria-label', () => {
    const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({
      tag: m[0],
      inner: (m[1] ?? '').trim(),
    }));
    const iconOnly = buttons.filter(
      (b) => b.inner.length > 0 && !/[A-Za-z0-9]/.test(b.inner.replace(/<[^>]*>/g, '')),
    );
    const missing = iconOnly.filter((b) => !/aria-label=/.test(b.tag));
    assert.deepEqual(
      missing.map((b) => b.tag.slice(0, 80)),
      [],
      'icon-only buttons need aria-label',
    );
  });
});