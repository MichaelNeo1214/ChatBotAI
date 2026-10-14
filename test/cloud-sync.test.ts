import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const scriptJs = read('js/script.js');

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

describe('cloud sync writes real message content', () => {
  const push = block('async function syncToCloud', 'function scheduleSync');

  it('maps the field the message object actually uses', () => {
    // Regression: it read m.content, but stored messages carry `text`. Every
    // synced message was written with content undefined and arrived empty.
    has(push, /typeof m\.text === 'string' \? m\.text/, 'syncToCloud body');
    has(push, /content: body/, 'syncToCloud body');
    lacks(push, /content: m\.content,/, 'syncToCloud body');
  });

  it('always supplies a created_at', () => {
    // A null created_at violates the column's NOT NULL and fails the upsert.
    has(push, /created_at: m\.createdAt \|\| new Date\(\)\.toISOString\(\)/, 'syncToCloud body');
  });

  it('still writes raw content when present', () => {
    has(push, /raw_content:/, 'syncToCloud body');
  });
});

describe('cloud sync restores every conversation', () => {
  const pull = block('async function fetchFromCloud', 'function setCloudStatus');

  it('does not limit the restore to a single chat', () => {
    // Regression: limit(1) meant a new device could only ever restore one
    // thread, so the rest of the account looked permanently lost.
    lacks(pull, /\.limit\(1\)/, 'fetchFromCloud');
    has(pull, /const all = \(sRes && sRes\.data\) \|\| \[\]/, 'fetchFromCloud');
  });

  it('writes through the real session store, not the legacy single thread', () => {
    has(pull, /await saveSession\(session\)/, 'fetchFromCloud');
    has(pull, /await refreshConversations\(\)/, 'fetchFromCloud');
    // These are the pre-multi-session API and never reached the sidebar.
    lacks(pull, /renderCloudHistory\(/, 'fetchFromCloud');
    lacks(pull, /await saveHistory\(chatHistory\)/, 'fetchFromCloud');
  });

  it('stamps the owner so restored chats land in the signed-in scope', () => {
    has(pull, /owner: activeOwner\(\)/, 'fetchFromCloud');
  });

  it('reports failure instead of silently doing nothing', () => {
    has(pull, /setCloudStatus\('Cloud restore failed'\)/, 'fetchFromCloud');
    has(pull, /setCloudStatus\('No cloud chats yet'\)/, 'fetchFromCloud');
  });
});

describe('sign-in always hydrates', () => {
  const onSignIn = block('async function handleSignedIn', 'function initCloudSync');

  it('pulls even when local chats already exist', () => {
    // Regression: the pull was gated on an empty local store, so signing in on
    // a device that already had a guest chat never merged the account history.
    has(onSignIn, /await fetchFromCloud\(\)/, 'handleSignedIn');
    lacks(onSignIn, /if \(!local\.length\)/, 'handleSignedIn');
    lacks(onSignIn, /await loadHistory\(\)/, 'handleSignedIn');
  });

  it('still pushes local history that was never uploaded', () => {
    has(onSignIn, /scheduleSync\(\)/, 'handleSignedIn');
  });
});

describe('no literal escape sequences in user-facing text', () => {
  it('has no double-escaped unicode left in string literals', () => {
    // "Syncing\\u2b26" rendered as the literal text backslash-u-2-b-2-6.
    const literals = (scriptJs.match(/\\\\u[0-9a-f]{4}/g) ?? []);
    assert.deepEqual(literals, [], `literal escapes remain: ${literals.join(', ')}`);
  });

it('does not use U+2B26 as an ellipsis', () => {
  // It is an obscure symbol that renders blank or as a box. Decorative
  // punctuation is flattened to ASCII so a future mis-decode cannot return.
  lacks(scriptJs, /\u2B26/, 'js/script.js');
  has(scriptJs, /slice\(0, 60\) \+ '\.\.\.'/, 'title truncation');
});

it('has no mojibake anywhere in the app script', () => {
  // A broad /[\u00C2-\u00E3]/ range also matches legitimate Latin-1 letters
  // such as n-tilde and c-cedilla, so the check decodes instead: a run only
  // counts as mojibake if re-encoding it yields valid UTF-8.
  const CP = { 0x20ac: 0x80, 0x201a: 0x82, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
    0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96,
    0x2014: 0x97, 0x2122: 0x99, 0x153: 0x9c, 0x161: 0x9a, 0x17e: 0x9e };
  const toByte: Record<number, number> = {};
  for (const [u, b] of Object.entries(CP)) toByte[Number(u)] = Number(b);

  const hits: string[] = [];
  for (let i = 0; i < scriptJs.length - 2; i++) {
    const lead = scriptJs.charCodeAt(i);
    if (lead < 0xc2 || lead > 0xe3) continue;
    const second = toByte[scriptJs.charCodeAt(i + 1)];
    const third = toByte[scriptJs.charCodeAt(i + 2)];
    if (second === undefined || third === undefined) continue;
    const decoded = Buffer.from([lead, second, third]).toString('utf8');
    if (!decoded.includes('\ufffd')) hits.push(scriptJs.substr(i, 3));
  }
  assert.deepEqual(hits, [], `js/script.js has mis-decoded UTF-8: ${JSON.stringify(hits.slice(0, 4))}`);
});
});

describe('multi-session cloud contract', () => {
  it('uses the same tables on both directions', () => {
    // A push to one table and a pull from another silently empties history.
    const push = block('async function syncToCloud', 'function scheduleSync');
    const pull = block('async function fetchFromCloud', 'function setCloudStatus');
    for (const table of ['chat_sessions', 'chat_messages']) {
      has(push, new RegExp(`from\\('${table}'\\)`), `syncToCloud -> ${table}`);
      has(pull, new RegExp(`from\\('${table}'\\)`), `fetchFromCloud -> ${table}`);
    }
  });

  it('keys messages by the same foreign key both ways', () => {
    const push = block('async function syncToCloud', 'function scheduleSync');
    const pull = block('async function fetchFromCloud', 'function setCloudStatus');
    has(push, /session_id: sessionData\.id/, 'syncToCloud');
    has(pull, /\.eq\('session_id', s\.id\)/, 'fetchFromCloud');
  });
});