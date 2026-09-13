import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConversationRow, MessageRow } from '../src/db/index.ts';

/**
 * Shared plumbing for the backend test suite.
 *
 * Nothing here touches the network until a test asks for it, so importing this
 * module is safe from any test file.
 *
 * `src/config.ts` reads `process.env` at import time, so a test file has to
 * configure the environment *before* its first `import` of anything under
 * `src/`. In an ES module, imports are hoisted above top-level statements, so
 * do it inside a dynamic import:
 *
 *   const { createTestServer, jar } = await (async () => {
 *     process.env.DATABASE_PATH = uniqueDbPath();
 *     process.env.AI_PROVIDER = 'mock';
 *     return import('./helpers.ts');
 *   })();
 */

/** A temp database path unique to one test file, so files never share state. */
export function uniqueDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'chatbotai-test-')), `${randomUUID()}.db`);
}

export interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

/** Starts the app on an ephemeral port. Port 0 avoids clashing with anything. */
export async function createTestServer(): Promise<TestServer> {
  const { createApp } = await import('../src/app.ts');

  const server = await new Promise<Server>((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export interface CookieJarOptions {
  baseUrl: string;
  /** A label that shows up in assertion messages. */
  name?: string;
}

/**
 * Models one browser: it stores cookies the way a browser would and replays
 * them on the next request. Two jars on the same server are two browsers.
 */
export class CookieJar {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly cookies = new Map<string, string>();

  constructor(options: CookieJarOptions) {
    this.baseUrl = options.baseUrl;
    this.name = options.name ?? 'jar';
  }

  /**
   * A jar can also be pointed at another server mid-test; ownership tests use
   * this to reuse one "browser" across a restart.
   */
  static async open(baseUrl: string, name?: string): Promise<CookieJar> {
    return new CookieJar({ baseUrl, name });
  }

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  /**
   * `fetch` wants one `Cookie` header, so every stored cookie is joined here.
   * An explicit per-request override wins, which is how tests pretend a cookie
   * was tampered with.
   */
  private cookieHeader(override?: string): string | undefined {
    if (override !== undefined) return override === '' ? undefined : override;
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  private store(response: Response): void {
    // A Set-Cookie delta as well as the full list, so nothing is missed.
    const raw = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];

    for (const header of raw) {
      const [pair] = header.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (!pair || separator === -1) continue;

      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();

      // Expired or emptied cookie means the server asked to forget it.
      if (value === '' || /max-age=0/i.test(header)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  async request(
    pathname: string,
    init: RequestInit & { cookieHeader?: string } = {},
  ): Promise<Response> {
    const { cookieHeader, ...rest } = init;

    const headers = new Headers(rest.headers);
    const cookie = this.cookieHeader(cookieHeader);
    if (cookie !== undefined && !headers.has('cookie')) {
      headers.set('cookie', cookie);
    }

    const response = await fetch(`${this.baseUrl}${pathname}`, { ...rest, headers });
    this.store(response);
    return response;
  }

  get(pathname: string, init: RequestInit = {}): Promise<Response> {
    return this.request(pathname, { ...init, method: 'GET' });
  }

  post(pathname: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
    return this.json('POST', pathname, body, init);
  }

  patch(pathname: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
    return this.json('PATCH', pathname, body, init);
  }

  delete(pathname: string, init: RequestInit = {}): Promise<Response> {
    return this.request(pathname, { ...init, method: 'DELETE' });
  }

  private json(
    method: string,
    pathname: string,
    body: unknown,
    init: RequestInit,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    return this.request(pathname, {
      ...init,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

export function jar(options: CookieJarOptions): CookieJar {
  return new CookieJar(options);
}

export type SseEventName = string | null;
export type SseEvent = [eventName: SseEventName, payload: unknown];

/**
 * Turns an SSE body into the ordered `[eventName, payload]` pairs a reader
 * would see. Parses the whole body at once, which is fine for tests: the
 * server closes the stream when the turn is over.
 */
export async function readSse(response: Response): Promise<SseEvent[]> {
  const text = await response.text();
  return parseSse(text);
}

/** Same parse as {@link readSse}, for bodies already in hand. */
export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];

  for (const block of text.split(/\r?\n\r?\n/)) {
    if (block.trim() === '') continue;

    let eventName: SseEventName = null;
    const dataLines: string[] = [];

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue; // comment / keep-alive
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
      }
    }

    if (dataLines.length === 0 && eventName === null) continue;

    const data = dataLines.join('\n');
    let payload: unknown = data;
    if (data !== '') {
      try {
        payload = JSON.parse(data);
      } catch {
        payload = data;
      }
    }
    events.push([eventName, payload]);
  }

  return events;
}

/** The event names in order, which is how the SSE tests assert the protocol. */
export function eventNames(events: SseEvent[]): SseEventName[] {
  return events.map(([name]) => name);
}

export function payloadsOf<T>(events: SseEvent[], name: string): T[] {
  return events.filter(([eventName]) => eventName === name).map(([, payload]) => payload as T);
}

/**
 * Waits until the wall clock has crossed into the next whole second.
 *
 * `conversations.updated_at` is written with SQLite's `datetime('now')`, which
 * has one-second resolution, so two rows created inside the same second tie and
 * `ORDER BY updated_at DESC` breaks that tie arbitrarily. Any test that asserts
 * relative ordering has to put the rows in different seconds first.
 */
export async function nextSecond(): Promise<void> {
  const target = Math.floor(Date.now() / 1000) * 1000 + 1000;
  while (Date.now() < target) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export interface ChatDelta {
  text: string;
}

export interface ChatDone {
  messageId: string;
  content: string;
}

export interface ChatMeta {
  conversationId: string;
  messageId: string;
}

/** The `done` event's content must be exactly the deltas glued together. */
export function joinDeltas(events: SseEvent[]): string {
  return payloadsOf<ChatDelta>(events, 'delta')
    .map((delta) => delta.text)
    .join('');
}

export interface ConversationBody {
  conversation: ConversationRow;
  messages: MessageRow[];
}

export interface ConversationListBody {
  conversations: ConversationRow[];
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  created_at?: string;
}

export interface AuthBody {
  user: PublicUser;
  claimedConversations?: number;
}

export interface MeBody {
  user: PublicUser | null;
}
