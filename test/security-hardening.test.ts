import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { rejectPrivateProviderUrl } from '../src/security/outbound-guard.ts';

const root = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

function has(source: string, pattern: RegExp, label: string): void {
  assert.ok(pattern.test(source), `${label} does not match ${pattern}`);
}

function lacks(source: string, pattern: RegExp, label: string): void {
  assert.ok(!pattern.test(source), `${label} must not match ${pattern}`);
}

afterEach(() => {
  delete process.env.ALLOW_PRIVATE_PROVIDER_HOSTS;
});

describe('SSRF guard', () => {
  const BLOCKED = [
    'http://127.0.0.1:8080/v1',
    'https://localhost/v1',
    'http://LOCALHOST:11434/v1',
    'https://app.localhost/v1',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/v1',
    'http://172.16.0.1/v1',
    'http://172.31.255.254/v1',
    'http://192.168.1.1/v1',
    'http://100.64.0.1/v1',
    'http://0.0.0.0/v1',
    'http://[::1]/v1',
    // Obfuscated spellings of the same addresses.
    'http://2130706433/v1', // 127.0.0.1 as an integer
    'http://0x7f.0.0.1/v1', // 127.0.0.1 in hex
    'http://[::ffff:127.0.0.1]/v1', // IPv4-mapped IPv6
    'http://metadata.internal/v1',
    'http://box.local/v1',
  ];

  for (const url of BLOCKED) {
    it(`rejects ${url}`, () => {
      assert.notEqual(rejectPrivateProviderUrl(url), null, `${url} must be rejected`);
    });
  }

  const ALLOWED = [
    'https://api.openai.com/v1',
    'https://generativelanguage.googleapis.com/v1beta',
    'https://openrouter.ai/api/v1',
    'https://api.anthropic.com',
    'https://example.com/v1',
    'https://1.2.3.4/v1', // public, not private
    'https://172.32.0.1/v1', // just outside 172.16/12
    'https://11.0.0.1/v1',
  ];

  for (const url of ALLOWED) {
    it(`allows ${url}`, () => {
      assert.equal(rejectPrivateProviderUrl(url), null);
    });
  }

  it('rejects non-http schemes', () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://example.com/']) {
      assert.notEqual(rejectPrivateProviderUrl(url), null, url);
    }
  });

  it('rejects an unparseable URL', () => {
    assert.notEqual(rejectPrivateProviderUrl('not a url'), null);
  });

  it('allows private hosts only when explicitly opted in', () => {
    assert.notEqual(rejectPrivateProviderUrl('http://192.168.1.5:11434/v1'), null);
    process.env.ALLOW_PRIVATE_PROVIDER_HOSTS = 'true';
    // Self-hosted Ollama/LM Studio on a LAN is a real BYOK use case.
    assert.equal(rejectPrivateProviderUrl('http://192.168.1.5:11434/v1'), null);
    // Scheme validation still applies even with the opt-in.
    assert.notEqual(rejectPrivateProviderUrl('file:///etc/passwd'), null);
  });

  it('is wired into every BYOK endpoint that accepts a base URL', () => {
    for (const file of ['api/chat.ts', 'api/image.ts']) {
      has(read(file), /rejectPrivateProviderUrl\(trimmed\)/, file);
    }
  });
});

describe('XSS: sanitiser must fail closed', () => {
  const scriptJs = read('js/script.js');

  it('never returns unsanitised HTML when DOMPurify is unavailable', () => {
    // The sanitiser is loaded from a CDN. An ad blocker, corporate proxy,
    // regional block or CDN outage leaves it undefined; returning `html` there
    // turns every model reply into an injection sink.
    const body = scriptJs.slice(
      scriptJs.indexOf('function sanitizeHtml(html)'),
      scriptJs.indexOf('function highlightCode('),
    );
    lacks(body, /^\s*return html;\s*$/m, 'sanitizeHtml fallback');

    // The fallback must escape, not pass through.
    for (const needle of ["'&amp;'", "'&lt;'", "'&gt;'"]) {
      assert.ok(body.includes(needle), `fallback escaping is missing ${needle}`);
    }
  });

  it('every rendered message body goes through the sanitiser', () => {
    has(scriptJs, /return sanitizeHtml\(html\.join\(''\)\)/, 'formatText return');
    has(scriptJs, /function sanitizeHtml\(html\)/, 'sanitizeHtml');
  });

  it('escapes attribute values separately from text', () => {
    has(scriptJs, /function escapeHtmlAttr\(value\)/, 'escapeHtmlAttr');
    has(scriptJs, /function escapeHtml\(s\)/, 'escapeHtml');
  });

  it('builds shared-link views with DOM APIs, not innerHTML', () => {
    // A shared conversation arrives from a URL the sender controls, so this is
    // the highest-risk sink in the app. innerHTML is permitted only when it is
    // an empty reset or a call through the sanitising renderer.
    const share = read('js/share-view.js');
    const risky = (share.match(/innerHTML\s*=\s*(.*)$/gm) ?? []).filter((line) => {
      const value = line.replace(/innerHTML\s*=\s*/, '').trim();
      return value !== "'';" && value !== '"";' && !/^format\(/.test(value);
    });
    assert.deepEqual(risky, [], `unsanitised innerHTML assignment: ${risky.join(' | ')}`);

    // The fallback must be textContent, never innerHTML.
    has(share, /body\.textContent = message\.text/, 'share-view fallback');

    // The renderer it delegates to must itself sanitise.
    has(share, /global\.__chatbotFormatText/, 'share-view renderer');
    has(read('js/script.js'), /__chatbotFormatText/, 'renderer export');
  });

  it('loads a pinned DOMPurify version', () => {
    const html = read('index.html');
    const match = /dompurify\/([\d.]+)\/purify\.min\.js/.exec(html);
    assert.ok(match, 'DOMPurify script tag not found');
    const version = match?.[1] ?? '';
    const [major, minor] = version.split('.').map(Number);
    assert.ok((major ?? 0) >= 3, `DOMPurify ${version} is not a 3.x release`);
    assert.ok((major ?? 0) > 3 || (minor ?? 0) >= 1, `DOMPurify ${version} is too old`);
  });
});

describe('secret hygiene', () => {
  it('keeps .env and local databases out of version control', () => {
    const ignore = read('.gitignore').split(/\r?\n/).map((l) => l.trim());
    for (const pattern of ['.env', '*.db', 'data/']) {
      assert.ok(ignore.includes(pattern), `.gitignore must contain ${pattern}`);
    }
  });

  it('never embeds a provider key in the served HTML or client script', () => {
    for (const file of ['index.html', 'js/script.js']) {
      const source = read(file);
      lacks(source, /sk-[A-Za-z0-9]{20,}/, file);
      lacks(source, /AIza[0-9A-Za-z_-]{30,}/, file);
      lacks(source, /sk-ant-[A-Za-z0-9_-]{20,}/, file);
      lacks(source, /ghp_[A-Za-z0-9]{20,}/, file);
    }
    // The browser may only ever see the publishable anon key, and only as a
    // deployment-time config hook.
    has(read('js/script.js'), /window\.CHATBOT_SUPABASE_ANON_KEY/, 'js/script.js');
  });

  it('marks the server-only key as never-for-the-browser', () => {
    const example = read('.env.example');
    assert.ok(
      /SUPABASE_SERVICE_ROLE_KEY[\s\S]{0,400}(never|server-only|server only)/i.test(example),
      '.env.example must warn that the service role key is server-only',
    );
  });

  it('returns no stack trace or upstream body from server errors', () => {
    for (const file of ['api/chat.ts', 'api/image.ts', 'api/title.ts', 'api/auth/index.ts']) {
      const source = read(file);
      lacks(source, /sendJson\(\s*res,\s*500,\s*\{[^}]*\.stack/s, file);
      lacks(source, /'internal_error',\s*(String\(error|error\.|`\$\{)/, file);
    }
  });
});