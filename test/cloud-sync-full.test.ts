import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = process.cwd();
const scriptJs = fs.readFileSync(path.join(root, 'js/script.js'), 'utf8');

function has(source: string, pattern: RegExp, label: string): void {
  assert.ok(pattern.test(source), `${label} does not match ${pattern}`);
}

function lacks(source: string, pattern: RegExp, label: string): void {
  assert.ok(!pattern.test(source), `${label} must not match ${pattern}`);
}

function block(name: string, endName: string): string {
  const start = scriptJs.indexOf(name);
  assert.ok(start >= 0, `${name} not found`);
  const end = scriptJs.indexOf(endName, start);
  return scriptJs.slice(start, end > start ? end : start + 4000);
}

describe('sync covers every conversation, not just the open one', () => {
  const all = block('async function syncAllSessionsToCloud', 'function setCloudStatus');

  it('iterates the session list rather than the active thread', () => {
    // Regression: scheduleSync pushed `chatHistory`, which is only the open
    // conversation. Every chat the user switched away from was never uploaded
    // and vanished the moment the browser cache was cleared.
    has(all, /const list = \(typeof sessions/, 'syncAllSessionsToCloud');
    lacks(all, /syncToCloud\(buildSessionData\(chatHistory\.slice\(\)\)\)/, 'syncAllSessionsToCloud');
  });

  it('skips empty conversations rather than creating blanks', () => {
    has(all, /if \(!\(data && data\.messages && data\.messages\.length\)\) continue;/, 'syncAllSessionsToCloud');
  });

  it('is what the debounced scheduler and Sync now both call', () => {
    const sched = block('function scheduleSync', 'function renderCloudHistory');
    has(sched, /syncAllSessionsToCloud\(\)/, 'scheduleSync');
    has(scriptJs, /await syncAllSessionsToCloud\(\)/, 'Sync now button');
  });

  it("never uploads another owner's conversations", () => {
    // Owner scoping is what stops a guest's chats leaking into the account
    // when the user then signs in on the same browser.
    has(all, /s\.owner !== activeOwner\(\)\) continue;/, 'syncAllSessionsToCloud');
  });

  it('reports how many chats were pushed', () => {
    has(all, /Synced ' \+ pushed/, 'syncAllSessionsToCloud');
  });
});

describe('guest sessions stay local', () => {
  it('does not sync anything while signed out', () => {
    const sched = block('function scheduleSync', 'function renderCloudHistory');
    has(sched, /if \(!supaUser\) return;/, 'scheduleSync');
    has(
      block('async function syncAllSessionsToCloud', 'function setCloudStatus'),
      /if \(!supaUser\) return false;/,
      'syncAllSessionsToCloud',
    );
    has(block('async function syncToCloud', 'function scheduleSync'), /if \(!client \|\| !supaUser \|\| !sessionData\) return false;/, 'syncToCloud');
  });

  it('pulls nothing while signed out', () => {
    has(block('async function fetchFromCloud', 'function setCloudStatus'), /if \(!client \|\| !supaUser\) return false;/, 'fetchFromCloud');
  });

  it('leaves cloud data intact on sign-out', () => {
    // Signing out is a local action: remote history must survive it, otherwise
    // signing out and back in destroys the account's chats.
    const out = block('function logoutCloud', 'async function handleSignedIn');
    has(out, /client\.auth\.signOut\(\)/, 'logoutCloud');
    lacks(out, /\.delete\(\)|\.remove\(\)|syncAllSessionsToCloud/, 'logoutCloud');
  });
});

describe('sign-in hydrates before it pushes', () => {
  const onSignIn = block('async function handleSignedIn', 'function initCloudSync');

  it('pulls the account history first', () => {
    const pullAt = onSignIn.indexOf('fetchFromCloud');
    const pushAt = onSignIn.indexOf('scheduleSync');
    assert.ok(pullAt >= 0 && pushAt > pullAt, 'pull must happen before any push');
  });

  it('restores every conversation, not one', () => {
    const pull = block('async function fetchFromCloud', 'function setCloudStatus');
    lacks(pull, /\.limit\(\d+\)/, 'fetchFromCloud');
    has(pull, /for \(let i = 0; i < all\.length; i\+\+\)/, 'fetchFromCloud');
  });

  it('writes restored chats through the real session store', () => {
    const pull = block('async function fetchFromCloud', 'function setCloudStatus');
    has(pull, /await saveSession\(session\)/, 'fetchFromCloud');
    has(pull, /await refreshConversations\(\)/, 'fetchFromCloud');
  });
});