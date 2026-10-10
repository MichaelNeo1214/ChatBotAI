/**
 * Multimodal attachments for a chat turn.
 *
 * The browser may send one small image alongside the text of a message. This
 * module is the single gate every HTTP entry point runs it through, so the
 * limits and the accepted MIME types are identical on the local Express server
 * and on the Vercel serverless function.
 *
 * Design notes:
 *  - Base64 arrives as a `data:` URL (what the browser produces naturally) or
 *    as a bare base64 string. Both are accepted; only the bare payload is kept.
 *  - A `data:` URL is NOT trusted blindly: the declared MIME type is ignored in
 *    favour of the magic bytes, so a caller cannot smuggle a script or an SVG
 *    (which can carry script) in as `image/png`.
 *  - Anything we cannot identify from its own bytes is rejected rather than
 *    passed through, because this payload is forwarded to a model vendor.
 */
import type { ChatImage } from './types.ts';

/**
 * Vendors reject oversized inline images, so this stays modest by design.
 *
 * 2 MB decoded is ~2.7 MB once base64-encoded, which leaves comfortable room
 * for the conversation history inside Vercel's 4.5 MB request-body ceiling.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;

/**
 * Ceiling on the base64 characters one turn may carry.
 *
 * A per-image limit alone is not enough: four allowed images would exceed the
 * platform body limit and fail the request for a reason the user cannot act on.
 * Images past this budget are dropped rather than sent.
 */
const MAX_TOTAL_IMAGE_CHARS = 3 * 1024 * 1024;

/** How much of an attached text document is pasted into the prompt. */
const MAX_DOCUMENT_CHARS = 60_000;

/** The formats every vision-capable chat model accepts. */
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;

/** Rejects anything that is not a canonical base64 string. */
function looksLikeBase64(value: string): boolean {
  if (value === '' || value.length % 4 !== 0) return false;
  if (!BASE64_ALPHABET.test(value)) return false;
  // At least one data character: a string of only '=' padding is meaningless.
  return /[A-Za-z0-9+/]/.test(value);
}

/**
 * Identifies a raster image from its magic bytes.
 *
 * SVG is intentionally NOT recognised: it is markup, and passing it to a model
 * vendor as an image is both unsupported and an injection surface.
 */
export function detectImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';

  // GIF: "GIF87a" / "GIF89a"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const tag = String.fromCharCode(bytes[3]!, bytes[4]!, bytes[5]!);
    if (tag === '87a' || tag === '89a') return 'image/gif';
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return undefined;
}

/** Decodes base64 into bytes in both Node and the browser, without Buffer. */
function decodeBase64(value: string): Uint8Array | null {
  if (!looksLikeBase64(value)) return null;

  // Node (serverless + Express) — always present at runtime.
  const maybeBuffer = (
    globalThis as {
      Buffer?: {
        from(s: string, enc: string): Uint8Array & { toString(enc: string): string };
      };
    }
  ).Buffer;
  if (maybeBuffer !== undefined) {
    const decoded = maybeBuffer.from(value, 'base64');
    // Buffer.from is lenient and silently drops invalid characters, so
    // re-encoding is what actually proves the payload was well-formed.
    const roundTrip = decoded.toString('base64').replace(/=+$/, '');
    if (decoded.length > 0 && roundTrip === value.replace(/=+$/, '')) {
      return decoded;
    }
  }

  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Splits "data:image/png;base64,AAAA" into its mime type and payload. */
function splitDataUrl(value: string): { declared: string; payload: string } | null {
  if (!value.startsWith('data:')) return null;
  const comma = value.indexOf(',');
  if (comma === -1) return null;

  const meta = value.slice(5, comma);
  const payload = value.slice(comma + 1);
  if (!/;base64$/i.test(meta)) return null;

  const declared = meta.slice(0, meta.length - ';base64'.length).trim().toLowerCase();
  return { declared, payload };
}

export interface ParsedAttachment {
  images: ChatImage[];
  /** Text of an attached .txt/.md/.csv file, already appended for the prompt. */
  documentText: string;
  documentName: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item.trim());
  }
  return out;
}

/**
 * Decodes ONE image entry (`{ mimeType?, data }` or a bare data URL string).
 * Returns undefined when the entry is unusable; the caller decides whether
 * that is fatal.
 */
function parseImage(value: unknown): ChatImage | undefined {
  let raw: string;
  if (typeof value === 'string') {
    raw = value;
  } else {
    const bag = asRecord(value);
    if (bag === null) return undefined;
    raw = readString(bag.data) || readString(bag.url) || readString(bag.base64);
    if (raw === '') return undefined;
  }

  const dataUrl = splitDataUrl(raw);
  const payload = dataUrl !== null ? dataUrl.payload : raw;

  const bytes = decodeBase64(payload);
  if (bytes === null || bytes.length === 0) return undefined;
  if (bytes.length > MAX_IMAGE_BYTES) return undefined;

  // The declared type is advisory only; the bytes decide.
  const mimeType = detectImageMime(bytes);
  if (mimeType === undefined || !ALLOWED_MIME.has(mimeType)) return undefined;

  return { mimeType, data: payload };
}

/**
 * Turns the request body's `attachments` field into trusted images + text.
 *
 * Unknown or oversized entries are skipped rather than rejected, so one bad
 * file cannot fail an otherwise valid turn; `rejected` reports what was lost so
 * the caller can tell the user.
 */
export function parseAttachments(value: unknown): ParsedAttachment & { rejected: number } {
  const bag = asRecord(value);
  if (bag === null) return { images: [], documentText: '', documentName: '', rejected: 0 };

  let rejected = 0;
  const images: ChatImage[] = [];
  let budget = MAX_TOTAL_IMAGE_CHARS;

  const addImage = (entry: unknown): void => {
    if (images.length >= MAX_IMAGES_PER_MESSAGE) {
      rejected += 1;
      return;
    }
    const image = parseImage(entry);
    if (image === undefined) {
      rejected += 1;
      return;
    }
    // Count what will actually be sent, not the decoded size.
    if (image.data.length > budget) {
      rejected += 1;
      return;
    }
    budget -= image.data.length;
    images.push(image);
  };

  const imageList = Array.isArray(bag.images) ? bag.images : [bag.image];
  for (const entry of imageList) {
    if (entry === undefined || entry === null) continue;
    addImage(entry);
  }

  // A plain-text document is carried as text, never as bytes.
  const docBag = asRecord(bag.document) ?? asRecord(bag.text);
  let documentText = '';
  let documentName = '';
  if (docBag !== null) {
    documentName = readString(docBag.name);
    const text = readString(docBag.text);
    if (text !== '') documentText = text;
  }

  // Tolerate the flat shapes too: { images: "..." } or { file: { type, data } }.
  if (documentText === '') {
    const flat = readString(bag.text) || readString(bag.documentText);
    if (flat !== '') documentText = flat;
  }
  if (images.length === 0) {
    const file = asRecord(bag.file);
    if (file !== null && readString(file.type).toLowerCase().startsWith('image/')) {
      addImage(file);
    }
  }

  const names = readStringArray(bag.fileNames);
  if (documentName === '' && names.length > 0) documentName = names[0]!;

  return { images, documentText, documentName, rejected };
}

/**
 * Wraps an attached document's text for the prompt.
 *
 * The text is truncated to a fixed budget because it is concatenated onto the
 * user's message, and the combined prompt is still length-checked by the
 * caller. ~60k characters keeps a long .md useful without eating the context
 * window the conversation itself needs.
 */
export function documentBlock(name: string, text: string): string {
  const label = name.trim() === '' ? 'attached document' : name.trim();
  const capped = text.length > MAX_DOCUMENT_CHARS ? text.slice(0, MAX_DOCUMENT_CHARS) + '\n…[truncated]' : text;
  return `[Attached document: ${label}]\n${capped}`;
}