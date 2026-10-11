/**
 * POST /api/title — Vercel Serverless Function.
 *
 * Produces a short conversation title so the sidebar is not a list of truncated
 * first words ("te", "yt", "please write a").
 *
 * Deliberately NOT part of /api/chat:
 *   * a title needs a few tokens, not a streamed turn, so this asks for a
 *     hard cap of 12 tokens and returns JSON;
 *   * it must not consume the chat rate limit, or every new conversation would
 *     cost a visitor two of their five turns per minute.
 *
 * Falls back to the caller's local keyword title whenever this is unavailable,
 * so a title is never the reason a conversation appears untitled.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { config } from '../src/config.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { isDemoProvider } from '../src/providers/index.ts';

type Req = IncomingMessage & { body?: unknown };
type Res = ServerResponse;

const MAX_INPUT_CHARS = 2000;
const BODY_READ_TIMEOUT_MS = 3000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TITLE_CHARS = 60;

const INSTRUCTIONS =
  'Write a title for this conversation. Reply with the title only: 3 to 6 words, ' +
  'no quotes, no trailing punctuation, no explanation. Use Title Case. ' +
  'Example: "Fixing CCTV Stream Output".';

function sendJson(res: Res, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(body));
}

function readBody(req: Req): Promise<Record<string, unknown>> {
  const pre = req.body;
  if (pre !== undefined && pre !== null) {
    if (typeof pre === 'object') return Promise.resolve(pre as Record<string, unknown>);
    if (typeof pre === 'string') {
      try {
        return Promise.resolve(JSON.parse(pre) as Record<string, unknown>);
      } catch {
        return Promise.resolve({});
      }
    }
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') return resolve({});
      try {
        const parsed: unknown = JSON.parse(text);
        resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    };

    const stream = req as unknown as Readable & { readableEnded?: boolean; destroyed?: boolean };
    if (typeof stream.on !== 'function') return finish();
    // An already-consumed stream emits nothing further; without this the
    // handler never responds and the platform reports a gateway error.
    if (stream.readableEnded === true || stream.destroyed === true) return finish();

    timer = setTimeout(finish, BODY_READ_TIMEOUT_MS);

    stream.on('data', (chunk: Buffer | Uint8Array | string) => {
      if (settled) return;
      size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        return finish();
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    });
    stream.on('end', finish);
    stream.on('error', finish);
    stream.on('close', finish);
  });
}

/** Strips the shapes a model adds around a title it was asked to produce. */
function normalizeTitle(value: string): string | null {
  const text = value
    .replace(/^\s*(?:title|summary)\s*[:\-]\s*/i, '')
    .replace(/^["'“”‘’]+/, '')
    .replace(/["'“”‘’]+$/, '')
    .replace(/[.\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (text === '') return null;
  // A response that ignored the instruction is not a title.
  if (text.length > MAX_TITLE_CHARS) return null;
  return text;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.end();
    return;
  }
  if (method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    sendJson(res, 405, { error: { status: 405, code: 'method_not_allowed', message: 'Use POST for /api/title.' } });
    return;
  }

  try {
    const body = await readBody(req);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, MAX_INPUT_CHARS) : '';
    const reply = typeof body.reply === 'string' ? body.reply.trim().slice(0, MAX_INPUT_CHARS) : '';

    if (prompt === '') {
      sendJson(res, 400, { error: { status: 400, code: 'bad_request', message: '"prompt" is required.' } });
      return;
    }

    // Demo mode has no model to ask, so the caller falls back to its local
    // keyword title rather than paying for a canned reply.
    if (isDemoProvider()) {
      sendJson(res, 503, { error: { status: 503, code: 'titles_unavailable', message: 'No model configured.' } });
      return;
    }

    const provider = new OpenAICompatibleProvider({
      baseUrl: config.provider.baseUrl,
      apiKey: config.provider.apiKey,
      model: config.provider.model,
      systemPrompt: INSTRUCTIONS,
      reasoningEffort: undefined,
    });

    const messages = [
      { role: 'user' as const, content: `Question: ${prompt}${reply ? `\n\nAnswer began: ${reply}` : ''}` },
    ];

    let answer = '';
    const abort = new AbortController();
    // Never let a slow upstream hold the connection open: the caller is waiting
    // on this to paint a sidebar title and will fall back if it is late.
    const guard = setTimeout(() => abort.abort(), 8000);

    try {
      for await (const chunk of provider.streamChat({
        messages,
        signal: abort.signal,
        parameters: { temperature: 0.2, maxTokens: 12 },
      })) {
        answer += chunk;
        if (answer.length > MAX_TITLE_CHARS) break;
      }
    } finally {
      clearTimeout(guard);
    }

    const title = normalizeTitle(answer);
    if (title === null) {
      sendJson(res, 502, { error: { status: 502, code: 'no_title', message: 'The model did not return a usable title.' } });
      return;
    }

    sendJson(res, 200, { title });
  } catch (error) {
    console.error('[api/title]', error);
    sendJson(res, 500, { error: { status: 500, code: 'internal_error', message: 'Internal server error' } });
  }
}