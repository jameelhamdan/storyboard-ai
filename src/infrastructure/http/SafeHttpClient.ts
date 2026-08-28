import { lookup as resolveDns } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
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

      const response = await this.send(url, pinned, remaining);
      const status = response.statusCode ?? 0;

      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();   // drain, so the socket can be reused or closed cleanly
        if (!location) {
          throw new UnsupportedFormatError(`Redirect from '${url.href}' had no Location header.`, { url: url.href });
        }
        // Re-validated from scratch: a redirect into 127.0.0.1 is the classic bypass.
        url = this.parseAndValidate(new URL(location, url).href);
        continue;
      }

      if (status < 200 || status >= 300) {
        response.resume();
        throw new UnsupportedFormatError(
          `Fetching '${url.href}' returned HTTP ${status}.`,
          { url: url.href, status },
        );
      }

      return {
        url: url.href,
        status,
        contentType: response.headers['content-type'],
        body: await this.readCapped(response, url.href),
      };
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
  private async resolveAndCheck(url: URL): Promise<string> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');

    const address = isIP(hostname)
      ? hostname
      : (await resolveDns(hostname, { verbatim: true })).address;

    if (isBlockedAddress(address)) {
      throw new UnsupportedFormatError(
        `'${url.hostname}' resolves to a private or link-local address and cannot be fetched.`,
        { url: url.href, resolved: address },
      );
    }

    return address;
  }

  /**
   * One request, connected to an address we have already checked while still
   * addressed to the real hostname.
   *
   * **This is why it is not `fetch`.** The pin has to affect the *socket* and
   * nothing else: put the IP in the URL instead and TLS verifies the certificate
   * against the IP, which fails for every HTTPS host on the internet —
   * `ERR_TLS_CERT_ALTNAME_INVALID`, or an SNI handshake alert before that. This
   * client did exactly that, so every https:// source failed with a bare
   * "fetch failed" and the `urls` input only ever worked over plain http.
   *
   * `lookup` is the right seam: Node hands DNS resolution to it, we return the
   * address already validated, and the URL keeps the hostname — so SNI, the
   * certificate check and the Host header are all correct, and there is still no
   * window between the check and the connect for DNS to change its answer.
   */
  private send(url: URL, address: string, timeoutMs: number): Promise<IncomingMessage> {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      const request = send(url, {
        method: 'GET',
        headers: { 'user-agent': 'studycore-generation/0.1 (+https://studycore.example)' },
        timeout: timeoutMs,
        // Always the checked address, whatever DNS would say now.
        lookup: (_hostname, options, callback) => {
          const family = isIP(address);
          if (typeof options === 'function') {
            (options as (e: Error | null, a: string, f: number) => void)(null, address, family);
            return;
          }
          if (options.all) {
            (callback as unknown as (e: Error | null, a: { address: string; family: number }[]) => void)(
              null, [{ address, family }],
            );
            return;
          }
          callback(null, address, family);
        },
      }, resolve);

      request.on('timeout', () => {
        request.destroy(new UnsupportedFormatError(`Timed out fetching '${url.href}'.`, { url: url.href }));
      });
      request.on('error', reject);
      request.end();
    });
  }

  private async readCapped(response: IncomingMessage, url: string): Promise<Buffer> {
    const declared = Number(response.headers['content-length'] ?? '0');
    if (declared > this.options.maxResponseBytes) {
      response.destroy();
      throw UnsupportedFormatError.overLimit(`response size for '${url}'`, declared, this.options.maxResponseBytes);
    }

    // Content-Length is a claim, not a guarantee — cap the actual stream too.
    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of Readable.from(response)) {
      const buffer = Buffer.from(chunk as Buffer);
      total += buffer.length;
      if (total > this.options.maxResponseBytes) {
        response.destroy();
        throw UnsupportedFormatError.overLimit(`response size for '${url}'`, total, this.options.maxResponseBytes);
      }
      chunks.push(buffer);
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
