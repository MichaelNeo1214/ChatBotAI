import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const scriptJs = read('js/script.js');
const healthApi = read('api/health.ts');
const authForm = read('components/auth/js/script.js');
const html = read('index.html');

function has(source: string, pattern: RegExp, label: string): void {
  assert.ok(pattern.test(source), `${label} does not match ${pattern}`);
}

function lacks(source: string, pattern: RegExp, label: string): void {
  assert.ok(!pattern.test(source), `${label} must not match ${pattern}`);
}

function block(source: string, name: string, endName: string): string {
  const start = source.indexOf(name);
  assert.ok(start >= 0, `${name} not found`);
  const end = source.indexOf(endName, start);
  return source.slice(start, end > start ? end : start + 3000);
}

describe('cloud sync can actually start', () => {
  it('has no hardcoded Supabase placeholders left in the app', () => {
    // Regression: SUPA_URL was 'https://YOUR-PROJECT-REF.supabase.co', and
    // cloudConfigured() rejected that literal, so every sync call returned
    // early and the whole feature was dead on every deployment.
    // Comments are stripped: this file's own note quotes the old placeholder.
    const code = scriptJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    lacks(code, /YOUR-PROJECT-REF/, 'js/script.js');
    lacks(code, /YOUR-PUBLIC-ANON-KEY/, 'js/script.js');
    lacks(html, /YOUR-PROJECT-REF/, 'index.html');
  });

  it('reads the project URL and anon key from /api/health', () => {
    has(scriptJs, /info\.supabase\.url/, 'serverCapabilitiesOnce');
    has(scriptJs, /info\.supabase\.anonKey/, 'serverCapabilitiesOnce');
    has(healthApi, /supabase: getPublicSupabaseConfig\(\)/, 'api/health');
  });

  it('exposes only the publishable key, never the service role', () => {
    // getPublicSupabaseConfig() reads only the public variable names and
    // rejects a service-role JWT/sb_secret_ key even when it was pasted into
    // SUPABASE_ANON_KEY by mistake.
    lacks(healthApi, /anonKey:\s*cleanSupabaseKey/, 'health payload');
    lacks(healthApi, /SERVICE_ROLE_KEY/, 'health payload');
    has(healthApi, /getPublicSupabaseConfig/, 'api/health');
  });

  it('loads the vendored Supabase browser SDK, with a fallback if the tag fails', () => {
    // Regression: initSupabase() returned null whenever window.supabase was
    // undefined and nothing loaded it, so signing in silently failed.
    has(html, /src="\/?vendor\/supabase\/2\.117\.3\/supabase\.min\.js"/, 'index.html preloads the SDK');
    has(scriptJs, /CLOUD_SUPABASE_SDK = '\/vendor\/supabase\/2\.117\.3\/supabase\.min\.js'/, 'js/script.js');
    has(scriptJs, /loadScript\(CLOUD_SUPABASE_SDK\)/, 'initSupabase');
    has(scriptJs, /function loadScript\(src\)/, 'js/script.js');
  });

  it('still refuses to run without a real configuration', () => {
    const cfg = block(scriptJs, 'function cloudConfigured', 'function initSupabase');
    has(cfg, /SUPA_URL\.indexOf\('http'\) === 0/, 'cloudConfigured');
    has(cfg, /SUPA_KEY\.length > 20/, 'cloudConfigured');
  });
});

describe('logout empties the view but keeps the account history', () => {
  it('handles SIGNED_OUT, which was previously ignored', () => {
    // Regression: only SIGNED_IN was handled, so after logging out the
    // account's conversations stayed in the sidebar.
    const listener = block(scriptJs, 'client.auth.onAuthStateChange', 'function initCloudSync');
    has(listener, /event === 'SIGNED_OUT'/, 'auth listener');
    has(listener, /resetChatView\(\)/, 'auth listener');
    has(listener, /refreshConversations\(\)/, 'auth listener');
  });

  it('clears the in-memory session list on sign-out', () => {
    const listener = block(scriptJs, 'client.auth.onAuthStateChange', 'function initCloudSync');
    has(listener, /sessions = \[\]/, 'auth listener');
  });

  it('never deletes anything from Supabase on sign-out', () => {
    const out = block(scriptJs, 'function logoutCloud', 'async function handleSignedIn');
    lacks(out, /\.delete\(\)|\.remove\(\)|from\('chat_/, 'logoutCloud');
    has(out, /client\.auth\.signOut\(\)/, 'logoutCloud');
  });

  it('does not destroy locally stored conversations when resetting the view', () => {
    const reset = block(scriptJs, 'function resetChatView', 'function renderHistory');
    lacks(reset, /idbDelete|deleteSession|\.clear\(\)/, 'resetChatView');
  });
});

describe('password visibility toggle actually toggles', () => {
  it('binds the input type to the toggle state', () => {
    // Regression: the type was hardcoded to "password", so the button changed
    // state but the field never changed.
    const bound = authForm.match(/type=\{showPassword \? "text" : "password"\}/g) ?? [];
    assert.equal(bound.length, 2, 'both password fields must bind their type');
    lacks(authForm, /type="password"/, 'auth form must not hardcode the input type');
  });

  it('keeps the button wired to the state it flips', () => {
    const buttons = authForm.match(/onClick=\{\(\) => setShowPassword\(v => !v\)\}/g) ?? [];
    assert.equal(buttons.length, 2, 'both forms need a working toggle');
    has(authForm, /aria-pressed=\{showPassword\}/, 'auth form');
  });

  it('starts hidden, as a password field must', () => {
    has(authForm, /useState\(false\)/, 'showPassword initial state');
  });
});