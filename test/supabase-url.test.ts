import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanSupabaseKey, cleanSupabaseUrl, getSanitizedSupabaseKey, getValidSupabaseUrl, supabaseIsConfigured } from '../src/supabase-url.ts';

/**
 * SUPABASE_URL normalisation.
 *
 * The reported failure was:
 *   "404 POST /rest/v1/auth/v1/signup" -> "Invalid path specified in request URL"
 *
 * caused by SUPABASE_URL being set to the Data API value (…/rest/v1) copied
 * from the dashboard, which the SDK then appends its own /auth/v1 to.
 */
describe('cleanSupabaseUrl', () => {
  it('leaves a correct project URL untouched', () => {
    assert.equal(
      cleanSupabaseUrl('https://abcdefgh.supabase.co'),
      'https://abcdefgh.supabase.co',
    );
  });

  it('strips the Data API suffix that causes the 404', () => {
    // This is the exact case that was reported.
    assert.equal(
      cleanSupabaseUrl('https://abcdefgh.supabase.co/rest/v1'),
      'https://abcdefgh.supabase.co',
    );
  });

  it('strips every documented API path suffix', () => {
    const cases = [
      ['https://abcdefgh.supabase.co/rest/v1', 'https://abcdefgh.supabase.co'],
      ['https://abcdefgh.supabase.co/rest/v1/', 'https://abcdefgh.supabase.co'],
      ['https://abcdefgh.supabase.co/auth/v1', 'https://abcdefgh.supabase.co'],
      ['https://abcdefgh.supabase.co/auth/v1/', 'https://abcdefgh.supabase.co'],
      ['https://abcdefgh.supabase.co/postgres', 'https://abcdefgh.supabase.co'],
      ['https://abcdefgh.supabase.co/rest/v1///', 'https://abcdefgh.supabase.co'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(cleanSupabaseUrl(input), expected, `"${input}"`);
    }
  });

  it('is case-insensitive about the suffix', () => {
    assert.equal(cleanSupabaseUrl('https://x.supabase.co/REST/V1'), 'https://x.supabase.co');
    assert.equal(cleanSupabaseUrl('https://x.supabase.co/Rest/V1/'), 'https://x.supabase.co');
  });

  it('strips quotes and whitespace from a pasted value', () => {
    assert.equal(cleanSupabaseUrl('"https://abcdefgh.supabase.co"'), 'https://abcdefgh.supabase.co');
    assert.equal(cleanSupabaseUrl("'https://abcdefgh.supabase.co'"), 'https://abcdefgh.supabase.co');
    assert.equal(cleanSupabaseUrl('  https://abcdefgh.supabase.co  '), 'https://abcdefgh.supabase.co');
    assert.equal(
      cleanSupabaseUrl('"https://abcdefgh.supabase.co/rest/v1"'),
      'https://abcdefgh.supabase.co',
    );
  });

  it('adds a missing scheme', () => {
    assert.equal(cleanSupabaseUrl('abcdefgh.supabase.co'), 'https://abcdefgh.supabase.co');
    assert.equal(cleanSupabaseUrl('abcdefgh.supabase.co/rest/v1'), 'https://abcdefgh.supabase.co');
  });

  it('preserves http for a self-hosted instance', () => {
    assert.equal(cleanSupabaseUrl('http://localhost:54321'), 'http://localhost:54321');
  });

  it('does not strip an occurrence that is not at the end', () => {
    // Anchored at the end: the SDK only appends to the root, so a legitimate
    // sub-path that merely contains the word must survive intact.
    assert.equal(
      cleanSupabaseUrl('https://x.supabase.co/myapp/rest/v1/thing'),
      'https://x.supabase.co/myapp/rest/v1/thing',
    );
    assert.equal(
      cleanSupabaseUrl('https://x.supabase.co/auth/v1/callback'),
      'https://x.supabase.co/auth/v1/callback',
    );
  });

  it('strips a trailing suffix even when the project sits under a prefix', () => {
    // Ending in /rest/v1 is the Data API value whatever precedes it.
    assert.equal(
      cleanSupabaseUrl('https://x.supabase.co/myapp/rest/v1'),
      'https://x.supabase.co/myapp',
    );
  });

  it('returns an empty string for anything unusable', () => {
    for (const input of ['', '   ', '""', undefined, null, '\'\'']) {
      assert.equal(cleanSupabaseUrl(input), '', `${JSON.stringify(input)} should be empty`);
    }
  });

  it('never yields a trailing slash', () => {
    for (const input of ['https://x.supabase.co/', 'https://x.supabase.co//', 'x.supabase.co///']) {
      assert.doesNotMatch(cleanSupabaseUrl(input), /\/$/);
    }
  });
});

describe('cleanSupabaseKey', () => {
  it('strips quotes and whitespace', () => {
    assert.equal(cleanSupabaseKey('"anon-key"'), 'anon-key');
    assert.equal(cleanSupabaseKey('  anon-key  '), 'anon-key');
    assert.equal(cleanSupabaseKey("'anon-key'"), 'anon-key');
  });

  it('returns an empty string for missing values', () => {
    assert.equal(cleanSupabaseKey(undefined), '');
    assert.equal(cleanSupabaseKey(null), '');
    assert.equal(cleanSupabaseKey('  '), '');
  });
});

describe('malformed URL handling', () => {
  // The reported crash was:
  //   Error: Invalid supabaseUrl: Provided URL is malformed.
  // createClient() throws that on anything new URL() rejects. Detection has to
  // happen before it is called, or the visitor sees an opaque 500.
  const MALFORMED = [
    'https://',
    'http://',
    'https:///rest/v1',
    'not a url',
    'my supabase project',
    'https://exa mple.supabase.co',
    '://missing-scheme',
  ];

  for (const input of MALFORMED) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      assert.equal(cleanSupabaseUrl(input), '');
      assert.equal(getValidSupabaseUrl({ SUPABASE_URL: input } as NodeJS.ProcessEnv), null);
      assert.equal(
        supabaseIsConfigured({ SUPABASE_URL: input, SUPABASE_ANON_KEY: 'anon' } as NodeJS.ProcessEnv),
        false,
      );
    });
  }

  it('still accepts every well-formed project URL', () => {
    for (const input of [
      'https://abcdefgh.supabase.co',
      'http://localhost:54321',
      'https://abcdefgh.supabase.co/rest/v1',
    ]) {
      assert.notEqual(getValidSupabaseUrl({ SUPABASE_URL: input } as NodeJS.ProcessEnv), null, input);
    }
  });

  it('strips newlines and tabs that a paste can introduce', () => {
    assert.equal(
      cleanSupabaseUrl('https://abcdefgh.supabase.co\r\n/rest/v1'),
      'https://abcdefgh.supabase.co',
    );
    assert.equal(cleanSupabaseKey('anon-key\r\n'), 'anon-key');
  });
});

describe('getValidSupabaseUrl', () => {
  it('falls back through the accepted variable names', () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ SUPABASE_URL: 'https://a.supabase.co' }, 'https://a.supabase.co'],
      [{ NEXT_PUBLIC_SUPABASE_URL: 'https://b.supabase.co' }, 'https://b.supabase.co'],
      [{ VITE_SUPABASE_URL: 'https://c.supabase.co' }, 'https://c.supabase.co'],
    ];
    for (const [env, expected] of cases) {
      assert.equal(getValidSupabaseUrl(env as NodeJS.ProcessEnv), expected, JSON.stringify(env));
    }
  });

  it('returns null when nothing is set', () => {
    assert.equal(getValidSupabaseUrl({} as NodeJS.ProcessEnv), null);
  });

  it('prefers SUPABASE_URL over the fallbacks', () => {
    assert.equal(
      getValidSupabaseUrl({
        SUPABASE_URL: 'https://primary.supabase.co',
        NEXT_PUBLIC_SUPABASE_URL: 'https://secondary.supabase.co',
      } as NodeJS.ProcessEnv),
      'https://primary.supabase.co',
    );
  });
});

describe('getSanitizedSupabaseKey', () => {
  it('reads the anon key and strips paste damage', () => {
    assert.equal(
      getSanitizedSupabaseKey({ SUPABASE_ANON_KEY: '"anon-key"\r\n' } as NodeJS.ProcessEnv),
      'anon-key',
    );
  });

  it('never falls back to the service role key', () => {
    // The service role bypasses Row Level Security. Reading it here would risk
    // it being used as the shared client credential.
    assert.equal(
      getSanitizedSupabaseKey({ SUPABASE_SERVICE_ROLE_KEY: 'service' } as NodeJS.ProcessEnv),
      '',
    );
  });

  it('falls back to the NEXT_PUBLIC name', () => {
    assert.equal(
      getSanitizedSupabaseKey({ NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' } as NodeJS.ProcessEnv),
      'anon',
    );
  });
});

describe('supabaseIsConfigured', () => {
  it('accepts a project URL and an anon key', () => {
    assert.equal(
      supabaseIsConfigured({
        SUPABASE_URL: 'https://abcdefgh.supabase.co',
        SUPABASE_ANON_KEY: 'anon',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('accepts a URL with the Data API suffix, which is the reported case', () => {
    // Accounts ARE configured; a suffix must not make this report false and
    // hide a working deployment behind a "not enabled" banner.
    assert.equal(
      supabaseIsConfigured({
        SUPABASE_URL: 'https://abcdefgh.supabase.co/rest/v1',
        SUPABASE_ANON_KEY: 'anon',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('falls back to the NEXT_PUBLIC_ names', () => {
    assert.equal(
      supabaseIsConfigured({
        NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('requires both a URL and a key', () => {
    assert.equal(supabaseIsConfigured({ SUPABASE_URL: 'https://x.supabase.co' } as NodeJS.ProcessEnv), false);
    assert.equal(supabaseIsConfigured({ SUPABASE_ANON_KEY: 'anon' } as NodeJS.ProcessEnv), false);
    assert.equal(supabaseIsConfigured({} as NodeJS.ProcessEnv), false);
  });

  it('treats a quoted key as present, since the value was pasted', () => {
    assert.equal(
      supabaseIsConfigured({
        SUPABASE_URL: 'https://x.supabase.co',
        SUPABASE_ANON_KEY: '"anon"',
      } as NodeJS.ProcessEnv),
      true,
    );
  });
});