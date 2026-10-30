import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const vercel = JSON.parse(read('vercel.json')) as {
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};
const app = read('src/app.ts');
const authPage = read('components/auth/signup.html');

function cspFor(source: string): string {
  const rule = vercel.headers.find((h) => h.source === source);
  assert.ok(rule, `no vercel.json header rule for ${source}`);
  const header = rule.headers.find((h) => h.key === 'Content-Security-Policy');
  assert.ok(header, `no CSP on ${source}`);
  return header.value;
}

function directive(csp: string, name: string): string {
  const match = new RegExp(`(?:^|;\\s*)${name} ([^;]*)`).exec(csp);
  return match?.[1] ?? '';
}

describe('CSP does not break the auth page', () => {
  // Regression: the main app's strict policy was applied to every path. Babel
  // Standalone injects the transformed component source as a brand new inline
  // <script>, which script-src blocks without 'unsafe-inline'. The browser
  // console showed a CSP violation, React never mounted, and #root stayed
  // empty: a blank white page at /components/auth/signup.html.
  it('the auth page is allowed to inject a compiled script', () => {
    const scriptSrc = directive(cspFor('/components/auth/(.*)'), 'script-src');
    assert.match(scriptSrc, /'unsafe-inline'/);
    // Babel compiles JSX with eval.
    assert.match(scriptSrc, /'unsafe-eval'/);
  });

  it('the auth page does not need a third-party origin', () => {
    const csp = cspFor('/components/auth/(.*)');
    assert.doesNotMatch(csp, /unpkg\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/);
    assert.equal(directive(csp, 'script-src'), "'self' 'unsafe-eval' 'unsafe-inline'");
  });

  it('the main app keeps the strict policy', () => {
    // Every script in index.html is a same-origin file, so it needs no inline
    // or eval source and no CDN host. Weakening this would undo the protection.
    const main = directive(cspFor('/(.*)'), 'script-src');
    assert.equal(main, "'self'", 'main app script-src');
  });

  it('the main policy has no wildcard or scheme-wide source', () => {
    const csp = cspFor('/(.*)');
    assert.doesNotMatch(csp, /(?:^|[\s;])\*(?:[\s;]|$)/, 'bare wildcard');
    assert.doesNotMatch(csp, /(?:^|[\s;])https:(?:[\s;]|$)/, 'https: scheme source');
    assert.doesNotMatch(csp, /'unsafe-eval'/, 'eval');
    // style-src-attr is the only directive allowed to carry 'unsafe-inline',
    // because KaTeX emits style attributes. A style-src or script-src
    // relaxation would be a real hole.
    assert.doesNotMatch(directive(csp, 'script-src'), /'unsafe-inline'/, 'inline script');
    assert.doesNotMatch(directive(csp, 'style-src'), /'unsafe-inline'/, 'inline style');
  });

  it('limits network access to the exact hosts the app uses', () => {
    const connect = directive(cspFor('/(.*)'), 'connect-src');
    assert.match(connect, /'self'/);
    assert.match(connect, /https:\/\/ydumwqgwoqwfhnyaskfe\.supabase\.co/);
    assert.match(connect, /wss:\/\/ydumwqgwoqwfhnyaskfe\.supabase\.co/);
    assert.match(connect, /https:\/\/api\.mymemory\.translated\.net/);
    assert.doesNotMatch(connect, /https:(?:\s|$)/, 'no scheme-wide connect-src');
  });

  it('keeps images local or data URLs', () => {
    assert.equal(directive(cspFor('/(.*)'), 'img-src'), "'self' data: blob:");
  });

  it('allows only inline style attributes, which KaTeX needs', () => {
    const csp = cspFor('/(.*)');
    assert.doesNotMatch(directive(csp, 'style-src'), /'unsafe-inline'/);
    assert.match(directive(csp, 'style-src-attr'), /'unsafe-inline'/);
  });

  it('the auth rule is listed AFTER the catch-all so it actually applies', () => {
    // Regression: Vercel applies every matching rule and the LAST one wins for
    // a repeated header key. Listing the auth exception first meant the
    // /(.*) catch-all overrode it, the strict policy was served on the auth
    // page, and Babel's injected inline script was blocked: a blank page with
    // "Either 'unsafe-inline' ... is required to enable inline execution".
    const catchAll = vercel.headers.findIndex((h) => h.source === '/(.*)');
    const auth = vercel.headers.findIndex((h) => h.source === '/components/auth/(.*)');
    assert.ok(catchAll >= 0, 'catch-all rule missing');
    assert.ok(auth >= 0, 'auth rule missing');
    assert.ok(auth > catchAll, 'the auth rule must come after the catch-all to override it');
  });

  it('Express applies the same split', () => {
    assert.match(app, /const isAuthPage = req\.path\.indexOf\('\/components\/auth\/'\) === 0;/, 'src/app.ts');
    assert.match(app, /'unsafe-inline'/, 'src/app.ts');
    assert.match(app, /\? "'self' 'unsafe-eval' 'unsafe-inline'"/, 'auth script-src');
    assert.match(app, /: "'self'";/, 'main script-src');
  });

  it('the auth page itself only loads external scripts', () => {
    // If this ever becomes false, the relaxed policy could be tightened again.
    const inline = authPage.match(/<script(?![^>]*\bsrc=)[^>]*>/g) ?? [];
    assert.deepEqual(inline, [], 'auth page must not add inline script blocks');
    assert.match(authPage, /type="text\/babel"/, 'auth page compiles via Babel');
  });

  it('keeps the non-negotiable protections on both paths', () => {
    for (const source of ['/components/auth/(.*)', '/(.*)']) {
      const csp = cspFor(source);
      assert.match(csp, /object-src 'none'/, `${source} object-src`);
      assert.match(csp, /base-uri 'self'/, `${source} base-uri`);
      assert.match(csp, /frame-ancestors 'none'/, `${source} frame-ancestors`);
      assert.match(csp, /form-action 'self'/, `${source} form-action`);
    }
  });
});
