import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

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

  it('the Express entrypoint and database helpers still work together', () => {
    // Guards the refactor: closeDb/getDb replaced the eagerly constructed handle.
    const index = read('src/index.ts');
    assert.match(index, /closeDb\(\)/, 'src/index.ts should close via closeDb()');
  });
});
