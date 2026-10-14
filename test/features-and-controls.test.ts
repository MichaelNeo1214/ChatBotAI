import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const html = read('index.html');
const scriptJs = read('js/script.js');
const voiceJs = read('js/voice.js');
const settingsJs = read('js/settings.js');
const css = read('css/style.css');
const sw = read('sw.js');

function has(source: string, pattern: RegExp, label: string): void {
  assert.ok(pattern.test(source), `${label} does not match ${pattern}`);
}

function lacks(source: string, pattern: RegExp, label: string): void {
  assert.ok(!pattern.test(source), `${label} must not match ${pattern}`);
}

/**
 * Every id in index.html that belongs to a control has to be reachable from
 * script. A control nothing reads is a button that looks live and does
 * nothing, which is worse than no button at all.
 */
describe('no dead controls', () => {
  const scripts = ['script.js', 'settings.js', 'ui.js', 'title.js', 'lightbox.js', 'share.js', 'voice.js']
    .map((f) => read(`js/${f}`))
    .join('\n');

  const ids = [...html.matchAll(/id="([A-Za-z0-9_]+)"/g)].map((m) => m[1] ?? '');

  // Ids that are intentionally not script-referenced: landmarks, i18n labels
  // translated by data-i18n, and elements addressed through a cached local.
  const IGNORED = new Set(['main', 'settingsModal', 'profileTitle', 'keyAlertTitle']);

  const orphans = [...new Set(ids)].filter((id) => {
    if (IGNORED.has(id)) return false;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Wired directly, or referenced as a data-* target (the submenu pattern).
    if (new RegExp(`'${escaped}'|"${escaped}"|#${escaped}`).test(scripts)) return false;
    if (new RegExp(`data-[a-z-]+="${escaped}"`).test(html)) return false;
    return true;
  });

  assert.deepEqual(orphans, [], `controls present in the DOM but wired to nothing: ${orphans.join(', ')}`);
});

describe('no undeclared identifiers', () => {
  it('does not rely on legacy window[id] access for controls it uses', () => {
    // An element id used as a bare identifier resolves only through the
    // document's named-access behaviour, which is a legacy quirk.
    for (const id of ['appearanceSelect', 'speedSelect', 'voiceSelect']) {
      if (!new RegExp(`getElementById\\('${id}'\\)`).test(scriptJs) && !new RegExp(`getElementById\\("${id}"\\)`).test(scriptJs)) {
        // Either it is declared locally, or it is only touched by js/voice.js.
        const owner = `${scriptJs}\n${voiceJs}`;
        const usedElsewhere = new RegExp(`\\b${id}\\b`).test(owner);
        if (usedElsewhere) {
          assert.ok(
            new RegExp(`\\b(var|let|const)\\s+${id}\\s*=`).test(owner),
            `${id} is used but never declared`,
          );
        }
      }
    }
  });
});

describe('voice panel is a real feature', () => {
  it('offers the voices the device actually has', () => {
    // The panel used to advertise invented names for a feature that did not exist.
    lacks(html, /<option value="Ember">|<option value="Sky">|<option value="Nova">|<option value="Sol">/, 'index.html');
    has(html, /<option value="">Automatic<\/option>/, 'index.html');
    // The list is filled from speechSynthesis.getVoices().
    has(voiceJs, /synth\.getVoices\(\)/, 'js/voice.js');
    has(voiceJs, /synth\.addEventListener\('voiceschanged'/, 'js/voice.js');
  });

  it('persists voice and rate through the settings store', () => {
    has(settingsJs, /ttsVoice: ''/, 'settings store defaults');
    has(settingsJs, /ttsRate: 1/, 'settings store defaults');
    has(settingsJs, /ttsRate: \{ min: 0\.5, max: 2, step: 0\.05, default: 1 \}/, 'settings limits');
    // Both values must be validated on load, not trusted from localStorage.
    has(settingsJs, /out\.ttsVoice = typeof input\.ttsVoice === 'string'/, 'ttsVoice sanitize');
    has(voiceJs, /settings\.set\(\{ ttsVoice:/, 'js/voice.js');
    has(voiceJs, /settings\.set\(\{ ttsRate:/, 'js/voice.js');
  });

  it('clamps the rate so a tampered value cannot break synthesis', () => {
    has(settingsJs, /clampNumber\(input\.ttsRate, LIMITS\.ttsRate\)/, 'ttsRate sanitize');
    has(voiceJs, /isFinite\(rate\)/, 'js/voice.js');
  });

  it('adds a read-aloud control to assistant replies only', () => {
    has(scriptJs, /data-tts-toggle/, 'message action');
    // The raw text travels in the attribute, escaped for attribute context.
    has(scriptJs, /data-tts-text="'\s*\+ escapeHtmlAttr\(text\)/, 'message action');
    has(scriptJs, /copyAction \+ speakAction \+ regenerateAction/, 'assistant actions');
    lacks(scriptJs, /copyAction \+ editAction \+ speakAction/, 'user actions');
  });

  it('allows the data attributes through the sanitiser', () => {
    has(scriptJs, /'data-tts-toggle', 'data-tts-text'/, 'DOMPurify ADD_ATTR');
  });

  it('strips markdown noise before speaking', () => {
    // Substring checks: these patterns are full of characters that are
    // ambiguous inside a test-file regex literal.
    assert.ok(voiceJs.includes(".replace(/^#{1,6}\\s+/gm, '')"), 'headings must be stripped');
    assert.ok(voiceJs.includes(".replace(/^\\s*[-*+]\\s+/gm, '')"), 'bullet markers');
    assert.ok(voiceJs.includes(".replace(/^\\s*>\\s?/gm, '')"), 'blockquote markers');
    assert.ok(voiceJs.includes("' code block '"), 'fenced code');
    assert.ok(voiceJs.includes('.replace(/`([^`]+)`/g'), 'inline code');
  });

  it('is wired into the page, the service worker and the styles', () => {
    has(html, /<script src="js\/voice\.js"><\/script>/, 'index.html');
    has(sw, /'\/js\/voice\.js'/, 'sw.js precache');
    has(css, /\.btn-msg-action\.is-speaking/, 'css/style.css');
    has(scriptJs, /ChatBotVoice\.attach\(speakBtn\)/, 'message binding');
  });

  it('stops talking when the thread is cleared', () => {
    has(scriptJs, /function resetChatView\(\)[\s\S]{0,400}ChatBotVoice\.stop\(\)/, 'resetChatView');
  });

  it('degrades quietly where speech is unavailable', () => {
    has(voiceJs, /supported: !!synth && typeof global\.SpeechSynthesisUtterance === 'function'/, 'support check');
    has(voiceJs, /This browser has no speech synthesiser/, 'unsupported notice');
    lacks(voiceJs, /throw new Error/, 'js/voice.js');
  });
});

describe('offline and caching', () => {
  it('bumps the cache so new assets are actually fetched', () => {
    has(sw, /const CACHE_NAME = 'chatbotai-static-v7'/, 'sw.js');
    // Assert the behaviour, not the prose: a cache hit is returned from the
    // cache and the network refresh is issued in the background.
    has(sw, /addEventListener\('fetch'/, 'fetch handler');
    has(sw, /event\.waitUntil\(/, 'background revalidation');
    has(sw, /caches\.match\(/, 'cache lookup');
  });

  it('never caches the auth page, which is compiled by Babel in the browser', () => {
    // type="text/babel" means a cached copy is executed as-is, so a stale
    // entry silently runs old JS and hides fixes that already shipped.
    has(sw, /url\.pathname\.indexOf\('\/components\/auth\/'\) === 0\) return;/, 'sw.js');
    assert.ok(
      !/\/components\/auth\//.test(sw.split('PRECACHE_URLS')[1]?.split(']')[0] ?? ''),
      'the auth script must not be precached',
    );
  });

  it('never caches API traffic', () => {
    lacks(sw, /\/api\/[^']*['"][^)]*cache\.add/, 'sw.js');
    has(sw, /api/, 'sw.js exclusion note');
  });
});

describe('no stack traces or secrets in shipped assets', () => {
  it('keeps provider keys out of every served file', () => {
    for (const file of ['index.html', 'js/script.js', 'js/settings.js', 'js/voice.js']) {
      lacks(read(file), /sk-[A-Za-z0-9]{20,}/, file);
      lacks(read(file), /AIza[0-9A-Za-z_-]{30,}/, file);
      lacks(read(file), /sk-ant-[A-Za-z0-9_-]{20,}/, file);
    }
  });

  it('speaks only sanitised or stripped text', () => {
    // Text reaches an <input>-free speech API, but it is still model output.
    has(voiceJs, /function speechText\(text\)/, 'js/voice.js');
    has(voiceJs, /String\(text == null \? '' : text\)/, 'null guard');
  });
});