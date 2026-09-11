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

const databasePath = str('DATABASE_PATH', './data/chatbot.db');

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

export const config = {
  env: str('NODE_ENV', 'development'),
  port: int('PORT', 3000),

  /** Absolute path to the SQLite file. */
  databasePath: path.isAbsolute(databasePath) ? databasePath : path.join(ROOT_DIR, databasePath),

  provider: {
    name: str('AI_PROVIDER', 'mock'),
    apiKey: str('AI_API_KEY', ''),
    model: str('AI_MODEL', 'claude-opus-5'),

    /** Base URL for the openai-compatible provider, without a trailing slash. */
    baseUrl: str('AI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),

    /**
     * Maps a frontend picker label ("GPT-4o", "DeepSeek", ...) to the model id
     * the upstream API expects. Anything unmapped falls back to AI_MODEL.
     */
    modelMap: parseModelMap(str('AI_MODEL_MAP', '')),
  },

  corsOrigins: str('CORS_ORIGINS', 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
} as const;

export const isProduction = config.env === 'production';
