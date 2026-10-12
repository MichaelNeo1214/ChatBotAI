import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const scriptJs = read('js/script.js');
const authForm = read('components/auth/js/script.js');
const indexHtml = read('index.html');
const authApi = read('api/auth/index.ts');

/**
 * Windows-1252 mojibake: UTF-8 bytes were decoded once as cp1252 and written
 * back, which is how "—" (E2 80 94) becomes "â€”".
 */
const CP1252_HIGH = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x2c6, 0x89: 0x2030, 0x8a: 0x160, 0x8b: 0x2039, 0x8c: 0x152, 0x8e: 0x17d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x2dc, 0x99: 0x2122, 0x9a: 0x161, 0x9b: 0x203a, 0x9c: 0x153, 0x9e: 0x17e, 0x9f: 0x178 };
const CP1252_REVERSE: Record<number, number> = {};
for (const [code, byte] of Object.entries(CP1252_HIGH)) CP1252_REVERSE[byte] = Number(code);

/** Every run of three chars that round-trips as valid UTF-8. */
function findMojibake(source: string): string[] {
  const hits: string[] = [];
  for (let i = 0; i < source.length - 2; i++) {
    const lead = source.charCodeAt(i);
    if (lead < 0xc2 || lead > 0xe3) continue;
    const second = CP1252_REVERSE[source.charCodeAt(i + 1)];
    const third = CP1252_REVERSE[source.charCodeAt(i + 2)];
    if (second === undefined || third === undefined) continue;
    const bytes: number[] = [lead, second, third];
    const decoded = Buffer.from(bytes).toString('utf8');
    if (!decoded.includes('\uFFFD')) hits.push(source.substr(i, 3));
  }
  return hits;
}

/** assert.ok keeps node from dumping the entire 230 KB script on failure. */
function has(source: string, pattern: RegExp, label: string): void {
  assert.ok(pattern.test(source), `${label} does not match ${pattern}`);
}

function lacks(source: string, pattern: RegExp, label: string): void {
  assert.ok(!pattern.test(source), `${label} must not match ${pattern}`);
}

describe('encoding', () => {
  for (const [name, source] of [
    ['js/script.js', scriptJs],
    ['index.html', indexHtml],
    ['components/auth/js/script.js', authForm],
  ] as const) {
    it(`${name} contains no cp1252 mojibake`, () => {
      const hits = findMojibake(source);
      assert.ok(hits.length === 0, `${name} still has mis-decoded UTF-8: ${JSON.stringify(hits.slice(0, 5))}`);
    });
  }

  it('declares UTF-8 as the first tag in <head>', () => {
    const head = indexHtml.slice(indexHtml.indexOf('<head>'));
    const first = head.slice(head.indexOf('>') + 1).trimStart();
    assert.ok(
      first.toLowerCase().startsWith('<meta charset="utf-8"') ||
        first.toLowerCase().startsWith("<meta charset='utf-8'"),
      `first tag in <head> is ${JSON.stringify(first.slice(0, 40))}`,
    );
  });

  it('shows the reported cloud-status message with readable punctuation', () => {
    // Regression: "Not connected â€” chats stay on this device."
    has(scriptJs, /Not connected [—\-] chats stay on this device\./, 'cloud status message');
    lacks(scriptJs, /Not connected â/, 'cloud status message');
  });

  it('escapes the sidebar remove control instead of a mangled sign', () => {
    // Regression: the multiplication sign was stored as "Ã—", so the button
    // rendered as three garbage characters.
    lacks(scriptJs, /Ã/, 'js/script.js');
    has(scriptJs, /remove\.textContent = '\\u00d7'/, 'remove control');
  });
});

describe('settings usage statistics', () => {
  it('refreshes stats from the settings MENU, not the panel container', () => {
    // Regression: the listener sat on #settingsPanels while the menu items live
    // in #settingsMenuList, a sibling. Clicks never reached it, so both panels
    // sat on "Calculating." forever.
    const block = scriptJs.slice(scriptJs.indexOf('const statsTrigger'));
    has(block, /getElementById\('settingsMenuList'\)/, 'stats listener host');
    has(block, /refreshUsageStats\(\)/, 'stats listener body');
    has(block, /panel === 'usage' \|\| panel === 'analytics'/, 'stats panel filter');
    lacks(scriptJs, /settingsPanelsHost/, 'js/script.js');
  });

  it('keeps the real element ids the panels actually use', () => {
    // A rewrite using statConvs/statMsgs would silently update nothing.
    for (const id of ['statConversations', 'statMessages', 'statStorage', 'statImages', 'statBusiest']) {
      assert.ok(indexHtml.includes(`id="${id}"`), `index.html is missing #${id}`);
      assert.ok(scriptJs.includes(`'${id}'`), `script.js never updates #${id}`);
    }
    lacks(scriptJs, /statConvs\b|statMsgs\b/, 'js/script.js');
  });

  it('computes stats asynchronously and cannot leave a placeholder behind', () => {
    has(scriptJs, /async function refreshUsageStats\(\)/, 'refreshUsageStats');
    has(scriptJs, /await loadSessions\(\)/, 'refreshUsageStats body');
    has(scriptJs, /stored\.length === 0\s*\?\s*'No conversations stored yet\.'/, 'empty-state branch');
  });

  it('initialises each settings panel exactly once', () => {
    // Regression: an orphaned top-level call threw a ReferenceError at load.
    assert.equal(
      (scriptJs.match(/^\s*initDataPrivacyPanel\(\);/gm) ?? []).length,
      1,
      'initDataPrivacyPanel() must be called once',
    );
    assert.equal((scriptJs.match(/^\s*initBehaviourPanel\(\);/gm) ?? []).length, 1);
    lacks(
      scriptJs,
      /DOMContentLoaded', enhanceAllSelects\);[\s\S]{0,80}init[A-Z]\w+\(\);/,
      'top level',
    );
  });
});

describe('auth rate limiting', () => {
  it('distinguishes throttling from bad credentials', () => {
    has(authApi, /function isRateLimited\(error: unknown\)/, 'api/auth');
    has(authApi, /err\.status === 429/, 'isRateLimited');
    has(authApi, /over_email_send_rate_limit/, 'isRateLimited');
  });

  it('never reports a throttled attempt as invalid credentials', () => {
    has(authApi, /result\.rateLimited[\s\S]{0,200}fail\(res, 429, 'rate_limited'/, 'login route');
    // The login branch must gate on rateLimited before the 401.
    const loginBlock = authApi.slice(authApi.indexOf('const result = await signInWithSupabase'));
    assert.ok(
      loginBlock.indexOf('rate_limited') < loginBlock.indexOf('invalid_credentials'),
      'rate_limited check must precede invalid_credentials',
    );
  });

  it('uses one message for throttling, distinct from the credential message', () => {
    has(authApi, /const RATE_LIMIT_MESSAGE/, 'api/auth');
    lacks(authApi, /Incorrect email or password\.[\s\S]{0,40}rate limit/i, 'api/auth');
  });

  it('shows a friendly rate-limit alert in the form', () => {
    has(authForm, /Too many sign-in attempts\. Please wait 60 seconds/, 'auth form');
    has(authForm, /res\.status === 429/, 'auth form');
  });
});

describe('auth form', () => {
  it('normalises the email client-side before sending', () => {
    has(authForm, /email\.trim\(\)\.toLowerCase\(\)/, 'auth form');
  });

  it('defines PasswordField at module scope with props, not a closure', () => {
    // Regression: defined inside LoginSignupComponent, the component type changed
    // on every keystroke, so React remounted the input and stole focus while the
    // user was still typing.
    const moduleScope = /^const PasswordField = \(\{/m;
    assert.ok(moduleScope.test(authForm), 'PasswordField must be defined at module level');
    // Horizontal whitespace only: \s also matches newlines, which would let a
    // column-0 definition match this and pass for a nested one.
    assert.doesNotMatch(authForm, /^[ \t]+const PasswordField =/m, 'PasswordField is still nested inside a component');

    // Visibility arrives as a prop, so the component is a pure function of props.
    has(authForm, /const PasswordField = \(\{ value, onChange, placeholder, autoComplete, minLength, show, onToggle \}\) => \(/, 'PasswordField signature');
    has(authForm, /type=\{show \? "text" : "password"\}/, 'PasswordField');
    has(authForm, /aria-label=\{show \? "Hide password" : "Show password"\}/, 'PasswordField');
    has(authForm, /aria-pressed=\{show\}/, 'PasswordField');
    // No closure over the parent's state.
    has(authForm, /onClick=\{onToggle\}/, 'PasswordField');
    lacks(authForm, /onClick=\{\(\) => setShowPassword/, 'PasswordField');
  });

  it('passes visibility props at both call sites', () => {
    assert.equal((authForm.match(/<PasswordField/g) ?? []).length, 2);
    assert.equal(
      (authForm.match(/show=\{showPassword\} onToggle=\{\(\) => setShowPassword\(v => !v\)\}/g) ?? []).length,
      2,
      'both call sites must pass show and onToggle',
    );
    has(authForm, /autoComplete="new-password" minLength=\{8\}/, 'signup password field');
    has(authForm, /type="email"[\s\S]{0,120}\brequired\b/, 'email field');
  });
});

describe('guest persistence', () => {
  it('uses the real active-conversation key, not an invented one', () => {
    has(scriptJs, /const ACTIVE_CONV_LS_KEY = 'chatbotai_active_conversation_id';/, 'js/script.js');
    has(scriptJs, /localStorage\.setItem\(ACTIVE_CONV_LS_KEY/, 'setActiveConversationId');
    has(scriptJs, /localStorage\.getItem\(ACTIVE_CONV_LS_KEY\)/, 'storedActiveConversationId');
    // Writing a second key would fork the source of truth and break restore.
    lacks(scriptJs, /active_chat_id/, 'js/script.js');
  });

  it('restores the sidebar from IndexedDB on startup', () => {
    has(scriptJs, /await refreshConversations\(\)/, 'js/script.js');
    has(scriptJs, /function renderHistory\(/, 'js/script.js');
    has(scriptJs, /function upsertActiveSession\(/, 'js/script.js');
  });
});