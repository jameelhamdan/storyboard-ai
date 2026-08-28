import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';

export interface SafeFetchOptions {
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly maxResponseBytes: number;
  readonly allowedSchemes: readonly string[];
}

export interface SafeFetchResult {
  readonly url: string;
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: Buffer;
}

/**
 * The SSRF guard from pipeline stage 1. Every outbound fetch of caller-supplied
 * URLs goes through here; an eslint rule forbids calling fetch directly anywhere.
 *
 * This matters more than usual for this service: the caller supplies arbitrary
 * URLs, the API has no auth, and the workers sit on an internal network next to
 * Redis. An unguarded fetcher would be a straightforward pivot into it.
 *
 * The defence is layered because any single layer is bypassable:
 *   - scheme allowlist (http/https only — no file:, gopher:, data:)
 *   - DNS resolution *then* range check, so a hostname resolving to 127.0.0.1 or
 *     169.254.169.254 is caught even though the name looks innocuous
 *   - the resolved IP is pinned for the actual connection, closing the
 *     DNS-rebinding window between check and connect
 *   - every redirect hop is re-validated from scratch
 *   - response size and total time are capped
 */
export class SafeHttpClient {
  constructor(private readonly options: SafeFetchOptions) {}

  public async fetch(rawUrl: string): Promise<SafeFetchResult> {
    const deadline = Date.now() + this.options.timeoutMs;
    let url = this.parseAndValidate(rawUrl);

    for (let hop = 0; hop <= this.options.maxRedirects; hop += 1) {
      const pinned = await this.resolveAndCheck(url);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new UnsupportedFormatError(`Timed out fetching '${rawUrl}'.`, { url: rawUrl });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);

      try {
        const response = await globalThis.fetch(pinned.requestUrl, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { Host: pinned.hostHeader, 'User-Agent': 'studycore-generation/0.1 (+https://studycore.example)' },
        });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) {
            throw new UnsupportedFormatError(`Redirect from '${url.href}' had no Location header.`, { url: url.href });
          }
          // Re-validated from scratch: a redirect into 127.0.0.1 is the classic bypass.
          url = this.parseAndValidate(new URL(location, url).href);
          continue;
        }

        if (!response.ok) {
          throw new UnsupportedFormatError(
            `Fetching '${url.href}' returned HTTP ${response.status}.`,
            { url: url.href, status: response.status },
          );
        }

        return {
          url: url.href,
          status: response.status,
          contentType: response.headers.get('content-type') ?? undefined,
          body: await this.readCapped(response, url.href),
        };
      } finally {
        clearTimeout(timer);
      }
    }

    throw new UnsupportedFormatError(
      `'${rawUrl}' exceeded ${this.options.maxRedirects} redirects.`,
      { url: rawUrl, max_redirects: this.options.maxRedirects },
    );
  }

  private parseAndValidate(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new UnsupportedFormatError(`'${raw}' is not a valid URL.`, { url: raw });
    }

    const scheme = url.protocol.replace(':', '');
    if (!this.options.allowedSchemes.includes(scheme)) {
      throw new UnsupportedFormatError(
        `Scheme '${scheme}' is not allowed; permitted: ${this.options.allowedSchemes.join(', ')}.`,
        { url: raw, scheme },
      );
    }
    return url;
  }

  /** Resolve first, check the address, then connect to that exact address. */
  private async resolveAndCheck(url: URL): Promise<{ requestUrl: string; hostHeader: string }> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');

    const address = isIP(hostname)
      ? hostname
      : (await lookup(hostname, { verbatim: true })).address;

    if (isBlockedAddress(address)) {
      throw new UnsupportedFormatError(
        `'${url.hostname}' resolves to a private or link-local address and cannot be fetched.`,
        { url: url.href, resolved: address },
      );
    }

    // Pin the connection to the address we just checked. Without this, a
    // second DNS lookup between check and connect can return a different answer.
    const pinned = new URL(url.href);
    pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;

    return { requestUrl: pinned.href, hostHeader: url.host };
  }

  private async readCapped(response: Response, url: string): Promise<Buffer> {
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > this.options.maxResponseBytes) {
      throw UnsupportedFormatError.overLimit(`response size for '${url}'`, declared, this.options.maxResponseBytes);
    }

    // Content-Length is a claim, not a guarantee — cap the actual stream too.
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);

    const chunks: Buffer[] = [];
    let total = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.options.maxResponseBytes) {
        await reader.cancel();
        throw UnsupportedFormatError.overLimit(`response size for '${url}'`, total, this.options.maxResponseBytes);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
}

/** RFC1918, loopback, link-local (incl. the cloud metadata endpoint), CGNAT, IPv6 ULA. */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true; // not an IP we can reason about — refuse
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true;                        // "this network"
  if (a === 10) return true;                       // RFC1918
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local + 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true;         // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true;           // IETF protocol assignments
  if (a >= 224) return true;                       // multicast + reserved
  return false;
}

function isBlockedIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;      // unspecified, loopback
  if (lower.startsWith('fe80')) return true;               // link-local
  if (/^f[cd]/.test(lower)) return true;                   // unique local (fc00::/7)
  if (lower.startsWith('ff')) return true;                 // multicast

  // IPv4-mapped (::ffff:127.0.0.1) must be checked as IPv4, not waved through.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isBlockedIpv4(mapped[1]);

  return false;
}
