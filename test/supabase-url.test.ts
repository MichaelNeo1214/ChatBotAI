import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cleanSupabaseKey,
  cleanSupabaseUrl,
  getPublicSupabaseConfig,
  getPublicSupabaseKey,
  getSanitizedSupabaseKey,
  getValidSupabaseUrl,
  isServiceRoleKey,
  supabaseIsConfigured,
} from '../src/supabase-url.ts';

/** Builds an unsigned JWT with the given payload, as Supabase issues them. */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

const SERVICE_JWT = fakeJwt({ role: 'service_role', iss: 'supabase' });
const ANON_JWT = fakeJwt({ role: 'anon', iss: 'supabase' });

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

describe('isServiceRoleKey', () => {
  it('detects the legacy service-role JWT', () => {
    assert.equal(isServiceRoleKey(SERVICE_JWT), true);
  });

  it('detects the opaque secret key format', () => {
    assert.equal(isServiceRoleKey('sb_secret_abcdefghijklmnop'), true);
  });

  it('accepts anon and publishable keys', () => {
    assert.equal(isServiceRoleKey(ANON_JWT), false);
    assert.equal(isServiceRoleKey('sb_publishable_abcdefghijklmnop'), false);
    assert.equal(isServiceRoleKey('anon-key'), false);
  });

  it('treats missing or malformed values as not secret', () => {
    for (const value of [undefined, null, '', '   ', 'not-a-jwt', 'a.b', 'a.b.c', 'a.!!!.c']) {
      assert.equal(isServiceRoleKey(value), false, JSON.stringify(value));
    }
  });

  it('ignores surrounding quotes and whitespace from a pasted key', () => {
    assert.equal(isServiceRoleKey(`"${SERVICE_JWT}"`), true);
    assert.equal(isServiceRoleKey(`  sb_secret_abc  `), true);
  });
});

describe('getPublicSupabaseKey', () => {
  it('returns the configured anon key', () => {
    assert.equal(
      getPublicSupabaseKey({ SUPABASE_ANON_KEY: 'anon-key' } as NodeJS.ProcessEnv),
      'anon-key',
    );
  });

  it('refuses a service-role JWT pasted into an anon variable', () => {
    // This is the reported leak: SUPABASE_ANON_KEY held the service role key,
    // so /api/health published a credential that bypasses RLS.
    assert.equal(
      getPublicSupabaseKey({ SUPABASE_ANON_KEY: SERVICE_JWT } as NodeJS.ProcessEnv),
      '',
    );
    assert.equal(
      getPublicSupabaseKey({ NEXT_PUBLIC_SUPABASE_ANON_KEY: SERVICE_JWT } as NodeJS.ProcessEnv),
      '',
    );
  });

  it('refuses an opaque secret pasted into an anon variable', () => {
    assert.equal(
      getPublicSupabaseKey({ SUPABASE_ANON_KEY: 'sb_secret_abcdefghijklmnop' } as NodeJS.ProcessEnv),
      '',
    );
  });

  it('refuses the service role key duplicated into the public variable', () => {
    assert.equal(
      getPublicSupabaseKey({
        SUPABASE_ANON_KEY: 'same-secret-value',
        SUPABASE_SERVICE_ROLE_KEY: 'same-secret-value',
      } as NodeJS.ProcessEnv),
      '',
    );
  });

  it('never falls back to the service role variable', () => {
    assert.equal(
      getPublicSupabaseKey({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_JWT } as NodeJS.ProcessEnv),
      '',
    );
    assert.equal(
      getPublicSupabaseKey({ SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abc' } as NodeJS.ProcessEnv),
      '',
    );
  });
});

describe('getPublicSupabaseConfig', () => {
  it('returns the normalised URL and anon key', () => {
    assert.deepEqual(
      getPublicSupabaseConfig({
        SUPABASE_URL: 'https://abcdefgh.supabase.co/rest/v1',
        SUPABASE_ANON_KEY: '"anon-key"\r\n',
      } as NodeJS.ProcessEnv),
      { url: 'https://abcdefgh.supabase.co', anonKey: 'anon-key' },
    );
  });

  it('returns null when the only key is a service-role key', () => {
    assert.equal(
      getPublicSupabaseConfig({
        SUPABASE_URL: 'https://abcdefgh.supabase.co',
        SUPABASE_ANON_KEY: SERVICE_JWT,
      } as NodeJS.ProcessEnv),
      null,
    );
    assert.equal(
      getPublicSupabaseConfig({
        SUPABASE_URL: 'https://abcdefgh.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_JWT,
      } as NodeJS.ProcessEnv),
      null,
    );
  });

  it('returns null when the URL or the key is missing', () => {
    assert.equal(
      getPublicSupabaseConfig({ SUPABASE_ANON_KEY: 'anon-key' } as NodeJS.ProcessEnv),
      null,
    );
    assert.equal(
      getPublicSupabaseConfig({ SUPABASE_URL: 'https://abcdefgh.supabase.co' } as NodeJS.ProcessEnv),
      null,
    );
    assert.equal(getPublicSupabaseConfig({} as NodeJS.ProcessEnv), null);
  });

  it('returns null rather than publishing a malformed URL', () => {
    assert.equal(
      getPublicSupabaseConfig({
        SUPABASE_URL: 'not a url',
        SUPABASE_ANON_KEY: 'anon-key',
      } as NodeJS.ProcessEnv),
      null,
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