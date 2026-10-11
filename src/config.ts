import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env if present. Absent is fine — every value below has a usable default.
const envFile = path.join(ROOT_DIR, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

function positiveInt(name: string, fallback: number): number {
  const value = int(name, fallback);
  if (value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${value}"`);
  }
  return value;
}

/**
 * How much of the X-Forwarded-For chain to believe when resolving req.ip.
 *
 * Off by default on purpose. A hop count above zero makes Express trust a
 * client-supplied X-Forwarded-For header, which anyone can forge to dodge the
 * per-IP rate limits. Only turn it on when the app really does sit behind a
 * proxy you control (nginx, Vercel, Cloudflare) — otherwise every visitor
 * collapses into one shared bucket.
 *
 *   TRUST_PROXY=false            off (default; req.ip is the socket address)
 *   TRUST_PROXY=1                trust exactly one hop
 *   TRUST_PROXY=loopback         trust loopback/CIDR entries only
 */
export function parseTrustProxy(raw: string): boolean | number | string {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'false' || value === 'off' || value === 'no') return false;
  if (value === 'true' || value === 'on' || value === 'yes') return true;
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  return raw;
}

const databasePath = str('DATABASE_PATH', './data/chatbot.db');

/**
 * Where the free tier talks to by default.
 *
 * OpenRouter is both the gateway and the free-model catalogue. `openrouter/free`
 * is its Free Models Router: it picks among the :free endpoints at request time,
 * so the app survives an individual free model going down and needs no change
 * when OpenRouter's free roster rotates. Swap AI_MODEL for a fixed id
 * (e.g. `qwen/qwen3.8-27b:free`) if you would rather pin one.
 *
 * The whole free tier is bounded by OpenRouter's own per-account limits — see
 * the note on chatRateLimit below. Nothing this app does can raise them.
 */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_FREE_MODEL = 'openrouter/free';

/**
 * Reasoning effort levels accepted by Space Bunny Alpha. Sent only when
 * AI_REASONING_EFFORT is set: gateways that do not know the field reject the
 * whole request, so this stays opt-in.
 */
const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

function parseReasoningEffort(raw: string): ReasoningEffort | undefined {
  const value = raw.trim().toLowerCase();
  if (value === '') return undefined;
  if ((REASONING_EFFORTS as readonly string[]).includes(value)) return value as ReasoningEffort;
  throw new Error(
    `AI_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(', ')}, got "${raw}"`,
  );
}

/**
 * Picks the boot provider.
 *
 * An explicit AI_PROVIDER always wins. Otherwise the server adapts to what it
 * was given: with a key it serves Space Bunny Alpha (the keyless-to-the-visitor
 * free tier), and with no key at all it falls back to the mock provider so a
 * fresh clone still runs offline instead of failing every request with a 401.
 */
function resolveProviderName(explicit: string, apiKey: string): string {
  const name = explicit.trim();
  if (name !== '') return name;
  return apiKey !== '' ? 'openai-compatible' : 'mock';
}

function parseModelMap(raw: string): Readonly<Record<string, string>> {
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AI_MODEL_MAP must be a JSON object, e.g. {"GPT-4o":"gpt-4o"}');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('AI_MODEL_MAP must be a JSON object, e.g. {"GPT-4o":"gpt-4o"}');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [label, model] of entries) {
    if (typeof model !== 'string') {
      throw new Error(`AI_MODEL_MAP entry "${label}" must map to a string model id`);
    }
  }
  return Object.fromEntries(entries as [string, string][]);
}

const providerApiKey = str('AI_API_KEY', '');

export const config = {
  env: str('NODE_ENV', 'development'),
  port: int('PORT', 3000),

  /** Absolute path to the SQLite file. */
  databasePath: path.isAbsolute(databasePath) ? databasePath : path.join(ROOT_DIR, databasePath),

  provider: {
    name: resolveProviderName(str('AI_PROVIDER', ''), providerApiKey),
    apiKey: providerApiKey,
    model: str('AI_MODEL', OPENROUTER_FREE_MODEL),

    /** Base URL for the openai-compatible provider, without a trailing slash. */
    baseUrl: str('AI_BASE_URL', OPENROUTER_BASE_URL).replace(/\/+$/, ''),

    /**
     * Maps a frontend picker label ("GPT-4o", "DeepSeek", ...) to the model id
     * the upstream API expects. Anything unmapped falls back to AI_MODEL.
     */
    modelMap: parseModelMap(str('AI_MODEL_MAP', '')),

    /** Passed to the upstream as `reasoning.effort`; undefined means omit it. */
    reasoningEffort: parseReasoningEffort(str('AI_REASONING_EFFORT', '')),

    /** Overrides the adapter's built-in system prompt. */
    systemPrompt: str('AI_SYSTEM_PROMPT', ''),
  },

  /**
   * Fixed-window limits on POST /api/chat. Each turn spends the server's own
   * key, so the per-owner cap stops one browser or account from looping, and
   * the per-IP cap is the backstop when cookies are cleared to dodge it.
   * Per-IP is looser because an office or campus shares one address.
   *
   * These are deliberately much lower than the old 20/60 defaults. OpenRouter's
   * free tier allows roughly 50 requests per DAY for the whole account, so a
   * 20-per-minute ceiling lets one visitor exhaust the entire daily budget in
   * three minutes and every other visitor then gets upstream 429s until the
   * quota resets.
   *
   * Important: a per-minute window cannot express a daily budget. These caps
   * limit burst damage, not total spend — the daily ceiling is OpenRouter's,
   * and it is shared across every visitor of the deployment. To serve real
   * traffic, either add credits to the OpenRouter account or use BYOK.
   */
  chatRateLimit: {
    windowMs: positiveInt('CHAT_RATE_LIMIT_WINDOW_MS', 60_000),
    perOwner: positiveInt('CHAT_RATE_LIMIT_PER_OWNER', 5),
    perIp: positiveInt('CHAT_RATE_LIMIT_PER_IP', 10),
  },

  corsOrigins: str('CORS_ORIGINS', 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  /** See parseTrustProxy. Only enable behind a proxy you control. */
  trustProxy: parseTrustProxy(str('TRUST_PROXY', 'false')),
} as const;

/**
 * The only top-level entries the static file server is allowed to expose.
 *
 * Everything else in the repo — data/chatbot.db (password + session hashes and
 * every stored message), src/, test/, node_modules/, package.json, .env
 * backups — must never be served. Keep this list in sync when adding an asset
 * directory to the frontend.
 */
export const STATIC_MOUNTS: readonly string[] = ['css', 'js', 'icons', 'components'];

/** Individual files served straight from the repo root. */
export const STATIC_FILES: readonly string[] = ['manifest.json', 'sw.js', 'favicon.ico'];

export const isProduction = config.env === 'production';
