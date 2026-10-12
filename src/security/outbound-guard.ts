/**
 * Outbound URL guard for caller-supplied provider endpoints (BYOK).
 *
 * `X-Provider-Base-Url` lets a browser point this server at any http(s) URL,
 * which is a server-side request forgery primitive: an attacker supplies both
 * the URL and the key, so the server fetches internal-only targets on their
 * behalf and hands back part of the response through the error text.
 *
 * Blocked here: loopback, link-local (including the cloud metadata address
 * 169.254.169.254), and RFC1918 / CGNAT private ranges, plus the literal
 * spellings of those addresses that a hostname can disguise (decimal,
 * octal, IPv4-mapped IPv6).
 *
 * Self-hosted providers on a private network are a legitimate use case, so the
 * restriction is relaxed by setting ALLOW_PRIVATE_PROVIDER_HOSTS=true. That is
 * off by default because the deployed site is public.
 */

const OPT_IN_ENV = 'ALLOW_PRIVATE_PROVIDER_HOSTS';

function allowPrivateHosts(): boolean {
  const raw = process.env[OPT_IN_ENV];
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}

/** Expands the alternative encodings a hostname may use to disguise an IP. */
function candidateAddresses(hostname: string): string[] {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const out = [host];

  // IPv4-mapped IPv6. WHATWG URL rewrites ::ffff:127.0.0.1 to the compressed
  // form ::ffff:7f00:1, so both spellings have to be decoded.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  const mappedHost = mapped?.[1];
  if (mappedHost !== undefined) out.push(mappedHost);

  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex) {
    const high = parseInt(mappedHex[1] ?? '0', 16);
    const low = parseInt(mappedHex[2] ?? '0', 16);
    if (Number.isFinite(high) && Number.isFinite(low)) {
      out.push(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
  }

  // Dotted forms with fewer than four parts, e.g. 0x7f.1 or 2130706433
  if (/^[\dx]+$/i.test(host) && host.indexOf('.') !== -1) {
    const parts = host.split('.');
    if (parts.length <= 4) {
      const value = parts.reduce<number>((acc, part) => {
        const n = /^0x/i.test(part) ? parseInt(part.slice(2), 16) : parseInt(part, 10);
        return acc * 256 + (Number.isFinite(n) ? n : 0);
      }, 0);
      if (Number.isFinite(value)) {
        out.push(`${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`);
      }
    }
  }
  if (/^\d+$/.test(host)) {
    const value = Number(host);
    if (Number.isFinite(value) && value <= 0xffffffff) {
      out.push(`${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`);
    }
  }
  return out;
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, includes cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIPv6(host: string): boolean {
  if (host !== '::' && host !== '::1') return false;
  return true;
}

/**
 * Returns null when the URL is safe to call, or a short reason describing why
 * it is not. Callers surface the reason as a 400.
 */
export function rejectPrivateProviderUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'The base URL header must be a valid http(s) URL.';
  }

  // Scheme is always checked, including when private hosts are opted in:
  // file:// and gopher:// are never a legitimate provider endpoint.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'The base URL header must use http or https.';
  }

  if (allowPrivateHosts()) return null;

  const hostname = parsed.hostname;
  if (hostname === '' || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return 'The base URL must not point at a local address.';
  }
  if (hostname.endsWith('.internal') || hostname.endsWith('.local')) {
    return 'The base URL must not point at an internal address.';
  }

  for (const address of candidateAddresses(hostname)) {
    if (isPrivateIPv4(address)) {
      return 'The base URL must not point at a local or private network address.';
    }
    if (isPrivateIPv6(address)) {
      return 'The base URL must not point at a local address.';
    }
  }
  return null;
}