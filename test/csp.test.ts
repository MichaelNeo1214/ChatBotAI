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

function scriptSrc(csp: string): string {
  const match = /script-src ([^;]*)/.exec(csp);
  assert.ok(match, 'CSP has no script-src');
  return match[1] ?? '';
}

describe('CSP does not break the auth page', () => {
  // Regression: the main app's strict policy was applied to every path. Babel
  // Standalone injects the transformed component source as a brand new inline
  // <script>, which script-src blocks without 'unsafe-inline'. The browser
  // console showed a CSP violation, React never mounted, and #root stayed
  // empty: a blank white page at /components/auth/signup.html.
  it('the auth page is allowed to inject a compiled script', () => {
    assert.match(scriptSrc(cspFor('/components/auth/(.*)')), /'unsafe-inline'/);
  });

  it('the main app keeps the strict policy', () => {
    // Every script in index.html is an external file, so it needs no inline
    // source. Weakening this would undo the protection.
    const main = scriptSrc(cspFor('/(.*)'));
    assert.doesNotMatch(main, /'unsafe-inline'/, 'main app script-src');
    assert.match(main, /'self'/, 'main app script-src');
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

  it('still allows the CDNs and Babel the auth page needs', () => {
    const src = scriptSrc(cspFor('/components/auth/(.*)'));
    for (const host of ['https://unpkg.com', 'https://cdnjs.cloudflare.com']) {
      assert.ok(src.includes(host), `auth script-src must allow ${host}`);
    }
    // Babel compiles JSX with eval.
    assert.match(src, /'unsafe-eval'/, 'Babel Standalone evaluates generated code');
  });

  it('Express applies the same split', () => {
    assert.match(app, /const isAuthPage = req\.path\.indexOf\('\/components\/auth\/'\) === 0;/, 'src/app.ts');
    assert.match(app, /'unsafe-inline'/, 'src/app.ts');
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