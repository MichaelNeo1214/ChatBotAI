import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'node:test';

const root = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const scriptJs = read('js/script.js');
const css = read('css/style.css');
const chatApi = read('api/chat.ts');

function has(source: string, pattern: RegExp, label: string): void {
  assert.ok(pattern.test(source), `${label} does not match ${pattern}`);
}

function lacks(source: string, pattern: RegExp, label: string): void {
  assert.ok(!pattern.test(source), `${label} must not match ${pattern}`);
}

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: '' };
  let statusCode = 0;
  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
      captured.status = value;
    },
    headersSent: false,
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    getHeader(name: string): string | undefined {
      return captured.headers[name.toLowerCase()];
    },
    write(chunk: string): boolean {
      captured.body += chunk;
      return true;
    },
    end(chunk?: string): void {
      if (chunk) captured.body += chunk;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

function fakeReq(method: string, headers: Record<string, string>, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  return Object.assign(stream, { method, headers }) as unknown as IncomingMessage;
}

describe('session owner isolation', () => {
  it('stamps an owner on every session write', () => {
    has(scriptJs, /Object\.assign\(\{\}, session, \{ owner: activeOwner\(\) \}\)/, 'saveSession');
    // Writing the caller's own object would leak the field into render state.
    lacks(scriptJs, /store\.put\(session\)/, 'saveSession');
  });

  it('scopes reads to the active owner', () => {
    has(scriptJs, /function filterSessionsByOwner\(all\)/, 'owner filter');
    has(scriptJs, /loadSessions\(\)[\s\S]{0,200}filterSessionsByOwner\(all\)/, 'loadSessions');
  });

  it('treats unscoped legacy records as guest rather than discarding them', () => {
    has(scriptJs, /s && s\.owner \? s\.owner : 'guest'/, 'legacy record fallback');
  });

  it('drops the open conversation when the owner changes', () => {
    has(scriptJs, /appliedOwner !== null && appliedOwner !== ownerKey\(\)/, 'owner change guard');
    has(scriptJs, /setActiveConversationId\(null\)/, 'owner change reset');
  });

  it('clears the persisted active-conversation pointer on reset', () => {
    // A bare `activeConversationId = null` leaves the localStorage pointer
    // behind, and the next boot tries to restore an invisible thread.
    has(
      scriptJs,
      /function resetChatView\(\)[\s\S]{0,320}setActiveConversationId\(null\)/,
      'resetChatView',
    );
  });

  it('keeps both owners data instead of deleting on sign-out', () => {
    has(scriptJs, /appliedOwner = ownerKey\(\);[\s\S]{0,200}renderFooter\(\)/, 'sign-out owner update');
    lacks(scriptJs, /indexedDB\.deleteDatabase/, 'js/script.js');
    lacks(scriptJs, /IDB_SESSIONS'\)[\s\S]{0,120}\.clear\(\)/, 'js/script.js');
  });

  it('never moves guest chats into the account namespace', () => {
    lacks(scriptJs, /owner: 'guest'\)\s*$/m, 'js/script.js');
    // Reassigning an owner onto another owner's records would defeat scoping.
    lacks(scriptJs, /\.owner = activeOwner\(\)/, 'js/script.js');
  });
});

describe('/api/chat origin guard', () => {
  const call = async (headers: Record<string, string>): Promise<Captured> => {
    const { default: handler } = await import('../api/chat.ts');
    const { res, captured } = fakeRes();
    await handler(fakeReq('POST', headers, { message: 'hi' }), res);
    return captured;
  };

  it('rejects a foreign origin with 403', async () => {
    const captured = await call({ origin: 'https://evil.example' });
    assert.equal(captured.status, 403);
    assert.match(captured.body, /forbidden_origin/);
  });

  it('allows a same-origin request using the Host header', async () => {
    const captured = await call({ origin: 'https://chat.michaelap.my.id', host: 'chat.michaelap.my.id' });
    assert.notEqual(captured.status, 403, 'the deployed domain must not be blocked');
  });

  it('allows a request with no Origin header', async () => {
    const captured = await call({});
    assert.notEqual(captured.status, 403, 'non-browser callers must not be blocked');
  });

  it('allows the configured development origin', async () => {
    const captured = await call({ origin: 'http://localhost:3000', host: 'localhost:3000' });
    assert.notEqual(captured.status, 403);
  });

  it('does not hard-code a single production origin', async () => {
    // Strict equality would break local dev and every preview deployment.
    // Comments are stripped first: this file's own note about that pattern
    // quotes it verbatim and would otherwise fail the check.
    const code = chatApi.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    lacks(code, /origin === 'https:\/\/chat\.michaelap\.my\.id'/, 'api/chat.ts');
    has(chatApi, /function originAllowed\(req: Req\)/, 'api/chat.ts');
    has(chatApi, /config\.corsOrigins/, 'api/chat.ts');
  });

  it('answers OPTIONS preflight and rejects a foreign one', async () => {
    const { default: handler } = await import('../api/chat.ts');

    const bad = fakeRes();
    await handler(fakeReq('OPTIONS', { origin: 'https://evil.example' }, {}), bad.res);
    assert.equal(bad.captured.status, 403);

    const good = fakeRes();
    await handler(
      fakeReq('OPTIONS', { origin: 'https://chat.michaelap.my.id', host: 'chat.michaelap.my.id' }, {}),
      good.res,
    );
    assert.equal(good.captured.status, 204);
    assert.equal(good.captured.headers['access-control-allow-origin'], 'https://chat.michaelap.my.id');
  });
});

describe('secret hygiene', () => {
  it('never logs a provider key to the browser console', () => {
    lacks(scriptJs, /console\.(log|debug|info|warn)\([^)]*(apikey|api_key|apiKey|token|secret|password)/i, 'js/script.js');
    lacks(read('components/auth/js/script.js'), /console\.(log|debug|info)\([^)]*(password|token)/i, 'auth form');
  });

  it('keeps keys in password inputs with no value in the DOM', () => {
    const html = read('index.html');
    const keyInputs = html.match(/<input[^>]*data-api-field="key"[^>]*>/g) ?? [];
    assert.ok(keyInputs.length >= 5, 'expected the per-provider key inputs');
    for (const tag of keyInputs) {
      assert.match(tag, /type="password"/, `key input is not masked: ${tag}`);
      lacks(tag, /value="/, tag);
    }
  });

  it('never returns a stack trace or raw error from the server', () => {
    for (const file of ['api/chat.ts', 'api/image.ts', 'api/title.ts', 'api/auth/index.ts']) {
      const source = read(file);
      lacks(source, /sendJson\(\s*res,\s*500,\s*\{[^}]*\.stack/s, file);
      // A 500 must carry a fixed string, not an interpolated exception.
      lacks(source, /'internal_error',\s*`\$\{/, file);
      lacks(source, /'internal_error',\s*String\(error/, file);
      has(source, /'internal_error'[\s\S]{0,40}Internal server error/, file);
    }
  });
});

describe('settings layout', () => {
  it('constrains the account email so it cannot overrun the panel', () => {
    has(css, /#accountEmail\{[^}]*max-width:60%[^}]*\}/s, 'css/style.css');
    has(css, /#accountEmail\{[^}]*text-overflow:ellipsis[^}]*\}/s, 'css/style.css');
    has(css, /#accountEmail\{[^}]*overflow:hidden[^}]*\}/s, 'css/style.css');
    // The ID must out-specify the .setting-desc class rule it overrides.
    assert.ok(
      css.indexOf('#accountEmail{') > css.indexOf('.setting-desc{'),
      'the #accountEmail rule must follow .setting-desc',
    );
  });

  it('lets rows with a button cluster wrap instead of overflowing', () => {
    has(css, /\.setting-row:has\( \.cloud-sync-actions \)\{[^}]*flex-wrap:wrap[^}]*\}/s, 'css/style.css');
    has(css, /\.cloud-sync-actions\{ min-width:0; max-width:100%; \}/, 'css/style.css');
  });

  it('drops back to a full-width wrapping email on narrow panels', () => {
    has(css, /@media \(max-width:520px\)\{\s*#accountEmail\{[^}]*word-break:break-all/s, 'css/style.css');
  });
});

describe('analytics panel', () => {
  it('keeps the stats refresh reachable from the menu', () => {
    // Fixed previously: the listener had been on #settingsPanels while the
    // menu items live in the sibling #settingsMenuList.
    const block = scriptJs.slice(scriptJs.indexOf('const statsTrigger'));
    has(block, /getElementById\('settingsMenuList'\)/, 'stats listener host');
    has(block, /refreshUsageStats\(\)/, 'stats listener body');
    lacks(scriptJs, /settingsPanelsHost/, 'js/script.js');
  });

  it('has no analytics renderer left stuck on a placeholder', () => {
    const html = read('index.html');
    for (const id of ['statByRole', 'statByModel', 'statFirstUsed', 'statLastUsed']) {
      assert.ok(html.includes(`id="${id}"`), `index.html missing #${id}`);
      has(scriptJs, new RegExp(`'${id}'`), id);
    }
    has(scriptJs, /async function refreshUsageStats\(\)/, 'refreshUsageStats');
    has(scriptJs, /await loadSessions\(\)/, 'refreshUsageStats');
  });

  it('populates every metric on the empty path too', () => {
    // A rejected promise must not leave the HTML placeholder in place.
    for (const empty of [
      'No conversations stored yet.',
      'No messages yet.',
      'No activity yet.',
    ]) {
      has(scriptJs, new RegExp(empty.replace(/\./g, '\\.')), empty);
    }
  });
});