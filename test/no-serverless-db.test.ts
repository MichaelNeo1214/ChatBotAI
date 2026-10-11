import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/** Reads and parses vercel.json. */
function readConfig(): {
  functions?: Record<string, unknown>;
  rewrites?: { source: string; destination: string }[];
} {
  return JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
}

/**
 * The serverless functions must never reach the SQLite layer.
 *
 * Vercel functions run on a read-only filesystem, so anything that opens
 * data/chatbot.db fails at runtime with a bare "unable to open database file"
 * that points nowhere near the real cause. The functions in api/ reuse the
 * provider layer from src/, which is why this boundary is easy to break by
 * accident: adding one import to a provider is enough.
 *
 * src/db/index.ts also opens lazily now, so this test is the belt to that
 * braces — it catches the dependency rather than waiting for a deploy to
 * discover it.
 */
const ROOT = process.cwd();

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

/** Every module reachable from `entry` by relative import. */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [path.resolve(ROOT, entry)];

  while (queue.length > 0) {
    const abs = queue.pop()!;
    if (seen.has(abs)) continue;
    seen.add(abs);

    let src: string;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    for (const match of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      queue.push(path.resolve(path.dirname(abs), match[1]!));
    }
  }

  return [...seen].map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
}

describe('serverless boundary', () => {
  const entries = ['api/chat.ts', 'api/health.ts', 'api/image.ts', 'api/shares.ts'];

  for (const entry of entries) {
    it(`${entry} never reaches the SQLite layer`, () => {
      let reachable: string[];
      try {
        reachable = reachableFrom(entry);
      } catch {
        // The file does not exist yet; nothing to guard.
        return;
      }

      const offenders = reachable.filter((f) => f === 'src/db/index.ts' || f.startsWith('src/db/'));
      assert.deepEqual(
        offenders,
        [],
        `${entry} must not import the SQLite layer (it would fail on a read-only filesystem)`,
      );
    });
  }

  it('no reachable serverless module writes to the filesystem at import time', () => {
    for (const entry of ['api/chat.ts', 'api/health.ts', 'api/image.ts']) {
      for (const file of reachableFrom(entry)) {
        let src: string;
        try {
          src = read(file);
        } catch {
          continue;
        }
        // node:fs is only a problem if a write is actually attempted. Reading
        // the schema in src/db/index.ts is why that module is banned outright.
        assert.doesNotMatch(
          src,
          /\b(mkdirSync|writeFileSync|appendFileSync|createWriteStream|DatabaseSync)\s*\(/,
          `${file} (reachable from ${entry}) performs a filesystem write`,
        );
      }
    }
  });

  it('src/db/index.ts opens the database lazily, not at import time', () => {
    const src = read('src/db/index.ts');
    // The DatabaseSync construction must sit inside a function body rather than
    // at module top level. A top-level `new DatabaseSync` is the original bug.
    assert.match(src, /function open\(\)/, 'expected a lazy open function');
    assert.match(src, /new DatabaseSync/, 'the lazy open should construct the handle');
    assert.doesNotMatch(
      src,
      /^export const db: DatabaseSync = new DatabaseSync/m,
      'the handle must not be constructed at module scope',
    );
  });

  it('every function declared in vercel.json actually exists', () => {
    const vercel = readConfig();
    const declared = Object.keys(vercel.functions ?? {});
    assert.ok(declared.length > 0, 'expected at least one declared function');

    const missing = declared.filter((relative) => !existsSync(path.join(ROOT, relative)));
    assert.deepEqual(missing, [], 'vercel.json declares functions that do not exist');
  });
});

/**
 * Vercel routes a request by the FILE it lands on: `api/auth/index.ts` serves
 * `/api/auth`, and nothing else. It does not send `/api/auth/me` to a handler
 * that merely inspects `req.url` — so a single catch-all file plus a URL parser
 * 404s every subpath, which is exactly what happened.
 *
 * This test asks the question the runtime asks: for every auth route the
 * frontend actually calls, does a file exist that Vercel will route it to?
 */
describe('serverless auth routing', () => {
  const AUTH_ROUTES = ['me', 'login', 'signup', 'logout', 'logout-all', 'account'] as const;

  it('has a routable file for every auth path the frontend calls', () => {
    const callers = ['js/script.js', 'components/auth/js/script.js'];
    const called = new Set<string>();

    for (const caller of callers) {
      let source: string;
      try {
        source = readFileSync(path.join(ROOT, caller), 'utf8');
      } catch {
        continue;
      }
      for (const match of source.matchAll(/\/api\/auth\/([a-z-]+)/g)) {
        called.add(match[1]!);
      }
    }

    assert.ok(called.size > 0, 'expected the frontend to call some auth route');

    for (const route of called) {
      assert.ok(
        AUTH_ROUTES.includes(route as (typeof AUTH_ROUTES)[number]),
        `frontend calls /api/auth/${route}, which is not a known auth route`,
      );
      assert.ok(
        existsSync(path.join(ROOT, 'api', 'auth', `${route}.ts`)),
        `frontend calls /api/auth/${route} but api/auth/${route}.ts does not exist, ` +
          'so Vercel cannot route it and it will 404',
      );
    }
  });

  it('serves the bare /api/auth route too', () => {
    assert.ok(
      existsSync(path.join(ROOT, 'api', 'auth', 'index.ts')),
      'api/auth/index.ts must exist to serve /api/auth',
    );
  });

  it('every auth handler default-exports the shared implementation', () => {
    for (const file of readdirSync(path.join(ROOT, 'api', 'auth'))) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(path.join(ROOT, 'api', 'auth', file), 'utf8');
      assert.match(
        source,
        /export default handler|export default async function handler/,
        `api/auth/${file} must default-export a handler`,
      );
    }
  });
});
