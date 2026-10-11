import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * The settings store.
 *
 * js/settings.js is a browser IIFE with no exports, so the file is evaluated
 * here against a stub global. The stub includes a localStorage that can be made
 * to fail, because "works when storage is available" is exactly the assumption
 * that breaks in Safari private mode.
 */
interface Settings {
  theme: string;
  model: string;
  systemPrompt: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  sendOnEnter: boolean;
  autoScroll: boolean;
}

interface SettingsApi {
  DEFAULTS: Settings;
  LIMITS: Record<string, { min?: number; max?: number; step?: number; default: unknown }>;
  STORAGE_KEY: string;
  get(): Settings;
  set(patch: Partial<Settings>): { state: Settings; changed: boolean };
  subscribe(fn: (s: Settings) => void): () => void;
  reset(): Settings;
  sanitize(raw: unknown): Settings;
  chatParameters(): Record<string, unknown>;
  applyTheme(): boolean;
  cycleTheme(): string;
  watchSystemTheme(): void;
  isStorageBroken(): boolean;
}

interface StubOptions {
  storageThrows?: boolean;
  seed?: unknown;
  matchMediaDark?: boolean;
  /**
   * Backing store, so a test can simulate a page reload by loading the module
   * twice against the same localStorage. Without this each load gets a fresh
   * Map and "persists across reload" cannot be asserted at all.
   */
  storage?: Map<string, string>;
}

/**
 * Loads the module fresh against a stubbed window.
 *
 * js/settings.js ends with `typeof window !== 'undefined' ? window : globalThis`,
 * so the stub must be installed as `window` — passing it as a function argument
 * would be ignored. Overwriting `globalThis.localStorage` directly does not work
 * either: Node ships its own `localStorage` accessor that takes precedence, so
 * the module would read and write the real one instead of the stub.
 */
function evaluate(stub: Record<string, unknown>): SettingsApi {
  const host = globalThis as Record<string, unknown>;
  const hadWindow = 'window' in host;
  const previousWindow = host.window;

  host.window = stub;
  delete host.ChatBotSettings;
  delete stub.ChatBotSettings;

  try {
    const source = readFileSync(path.join(process.cwd(), 'js', 'settings.js'), 'utf8');
    new Function(source)();

    // The module assigns onto whichever object it was handed as `window`.
    const loaded = stub.ChatBotSettings as SettingsApi | undefined;
    if (loaded === undefined) throw new Error('js/settings.js did not export ChatBotSettings');
    return loaded;
  } finally {
    if (hadWindow) host.window = previousWindow;
    else delete host.window;
    delete host.ChatBotSettings;
  }
}

function loadSettings(options: StubOptions = {}): SettingsApi {
  const store = options.storage ?? new Map<string, string>();
  if (options.seed !== undefined) store.set('chatbot.settings.v1', JSON.stringify(options.seed));

  const bodyClasses = new Set<string>();

  return evaluate({
    localStorage: {
      getItem: (k: string) => {
        if (options.storageThrows) throw new Error('storage disabled');
        return store.has(k) ? store.get(k)! : null;
      },
      setItem: (k: string, v: string) => {
        if (options.storageThrows) throw new Error('storage disabled');
        store.set(k, v);
      },
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    },
    matchMedia: (query: string) => ({
      matches: options.matchMediaDark === true,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
    document: {
      body: {
        classList: {
          toggle: (c: string, on: boolean) => (on ? bodyClasses.add(c) : bodyClasses.delete(c)),
        },
      },
      querySelector: () => null,
    },
  });
}

describe('settings store', () => {
  it('returns defaults on a first run', () => {
    const s = loadSettings();
    assert.deepEqual(s.get(), s.DEFAULTS);
    assert.equal(s.get().theme, 'dark');
    assert.equal(s.get().temperature, null);
  });

it('persists a change and reads it back on the next load', () => {
      // One backing store across both loads: the second load stands in for a
      // page reload reading what the first one wrote.
      const storage = new Map<string, string>();

      const first = loadSettings({ storage });
      first.set({ temperature: 0.3, systemPrompt: 'Be terse.' });
      assert.equal(first.get().temperature, 0.3);

      const second = loadSettings({ storage });
      assert.equal(second.get().temperature, 0.3);
      assert.equal(second.get().systemPrompt, 'Be terse.');
    });

  it('notifies subscribers and supports unsubscribe', () => {
    const s = loadSettings();
    const seen: number[] = [];
    const off = s.subscribe((next) => seen.push(next.temperature ?? -1));

    s.set({ temperature: 0.5 });
    s.set({ temperature: 0.6 });
    off();
    s.set({ temperature: 0.7 });

    assert.deepEqual(seen, [0.5, 0.6], 'unsubscribe must stop notifications');
  });

  it('does not throw when localStorage is unavailable', () => {
    // Safari private mode and disabled-storage settings both look like this.
    const s = loadSettings({ storageThrows: true });
    assert.doesNotThrow(() => s.set({ temperature: 0.2 }));
    assert.equal(s.get().temperature, 0.2, 'the in-memory value still applies');
    assert.equal(s.isStorageBroken?.(), true);
  });

  describe('sanitising', () => {
    it('rejects an unknown theme', () => {
      assert.equal(loadSettings({ seed: { theme: 'neon' } }).get().theme, 'dark');
    });

    it('accepts every documented theme', () => {
      for (const theme of ['dark', 'light', 'system']) {
        assert.equal(loadSettings({ seed: { theme } }).get().theme, theme);
      }
    });

    it('clamps an out-of-range temperature instead of rejecting the whole file', () => {
      assert.equal(loadSettings({ seed: { temperature: 9 } }).get().temperature, 2);
      assert.equal(loadSettings({ seed: { temperature: -4 } }).get().temperature, 0);
    });

    it('clamps topP and maxTokens', () => {
      assert.equal(loadSettings({ seed: { topP: 5 } }).get().topP, 1);
      assert.equal(loadSettings({ seed: { maxTokens: 10_000_000 } }).get().maxTokens, 64000);
    });

    it('treats an unparseable numeric as unset rather than zero', () => {
      const s = loadSettings({ seed: { temperature: 'hot', topP: null, maxTokens: '' } });
      assert.equal(s.get().temperature, null);
      assert.equal(s.get().topP, null);
      assert.equal(s.get().maxTokens, null);
    });

    it('truncates an over-long system prompt', () => {
      assert.equal(loadSettings({ seed: { systemPrompt: 'x'.repeat(9000) } }).get().systemPrompt.length, 8000);
    });

    it('recovers from corrupt stored JSON', () => {
      const api = evaluate({
        localStorage: {
          getItem: () => '{not json',
          setItem: () => {},
        },
      });
      assert.deepEqual(api.get(), api.DEFAULTS);
    });
  });

  describe('chatParameters', () => {
    it('is empty when nothing is set, so provider defaults apply', () => {
      assert.deepEqual(loadSettings().chatParameters(), {});
    });

    it('includes only the fields the user actually set', () => {
      const s = loadSettings();
      s.set({ systemPrompt: 'Be a pirate.', temperature: 0 });
      s.set({ topP: 0.9 });

      const params = s.chatParameters();
      assert.deepEqual(params, { systemPrompt: 'Be a pirate.', temperature: 0, topP: 0.9 });
      assert.ok(!('maxTokens' in params), 'unset fields must be absent, not null');
    });

    it('omits an empty system prompt rather than sending an empty string', () => {
      const s = loadSettings();
      s.set({ systemPrompt: '', temperature: 0.5 });
      assert.deepEqual(s.chatParameters(), { temperature: 0.5 });
    });
  });

  describe('theme', () => {
    it('cycles dark -> light -> system', () => {
      const s = loadSettings();
      assert.equal(s.cycleTheme(), 'light');
      assert.equal(s.cycleTheme(), 'system');
      assert.equal(s.cycleTheme(), 'dark');
    });
  });

it('reset restores defaults and persists them', () => {
      const storage = new Map<string, string>();
      const s = loadSettings({ storage });
      s.set({ temperature: 1.5, theme: 'light' });
      assert.deepEqual(s.reset(), s.DEFAULTS);
      assert.deepEqual(loadSettings({ storage }).get(), s.DEFAULTS);
    });
});
