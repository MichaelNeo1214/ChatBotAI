import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanSupabaseKey, cleanSupabaseUrl, supabaseIsConfigured } from '../src/supabase-url.ts';

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