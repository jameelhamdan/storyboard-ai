import type { ImageSourcePort, ImageQuery } from '@application/port/ImageSourcePort.js';
import type { SceneImage } from '@domain/media/SceneImage.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';
import { fetchImageBytes } from './fetchBytes.js';
import { inlineImage } from './inlineImage.js';

export interface OpenverseOptions {
  readonly requestTimeoutMs: number;
  /** Openverse asks that clients identify themselves; anonymous use is rate-limited. */
  readonly userAgent: string;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.openverse.org';

interface SearchResponse {
  readonly results?: readonly {
    readonly title?: string;
    readonly url?: string;
    readonly creator?: string;
    readonly license?: string;
    readonly license_version?: string;
    readonly foreign_landing_url?: string;
  }[];
}

/**
 * The open web's images, with a licence attached — and no API key.
 *
 * This is the `web_search` provenance done properly. The obvious
 * implementation, scraping image results out of a general search engine, has a
 * problem this service cannot live with: an arbitrary image found on an
 * arbitrary page has no licence anyone can state, and every other library here
 * publishes one. A board that cannot be credited is a board that cannot be used.
 *
 * Openverse indexes openly-licensed work from Flickr, Wikimedia, museums and
 * others, and returns the creator and the licence with each result — so the
 * credit line under the picture says something true, for the same "no
 * credentials" cost as scraping.
 *
 * Anonymous requests are rate-limited rather than refused, which suits a
 * pipeline that asks for one or two images per video.
 */
export class OpenverseImageSource implements ImageSourcePort {
  public readonly id: ImageSourceId = 'web_search';
  private readonly baseUrl: string;

  constructor(private readonly options: OpenverseOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  public async find(query: ImageQuery): Promise<SceneImage | undefined> {
    const url = new URL(`${this.baseUrl}/v1/images/`);
    url.searchParams.set('q', query.query);
    url.searchParams.set('page_size', '8');
    // Everything indexed here is openly licensed; this states the requirement
    // rather than relying on that staying true.
    url.searchParams.set('license_type', 'all-cc');
    if (query.orientation) url.searchParams.set('aspect_ratio', aspectFor(query.orientation));

    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const response = await fetch(url, {
      headers: { 'user-agent': this.options.userAgent, accept: 'application/json' },
      signal: query.signal ? AbortSignal.any([query.signal, timeout]) : timeout,
    });

    if (!response.ok) {
      throw new Error(`Openverse search failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }

    const body = (await response.json()) as SearchResponse;

    for (const result of body.results ?? []) {
      if (!result.url) continue;

      try {
        return await inlineImage({
          bytes: await fetchImageBytes(result.url, this.options.requestTimeoutMs, query.signal),
          alt: result.title?.trim() || query.query,
          attribution: {
            // Openverse leaves the creator blank for some collections; the
            // licence still has to be honoured, so it is credited to the
            // collection rather than to nobody.
            author: result.creator?.trim() || 'Unknown creator',
            sourceName: 'Openverse',
            sourceUrl: result.foreign_landing_url ?? result.url,
            licence: licenceOf(result.license, result.license_version),
          },
          source: 'web_search',
        });
      } catch {
        // Gone, hotlink-protected, or not decodable. Try the next result.
        continue;
      }
    }
    return undefined;
  }
}

/** `by-sa` + `4.0` reads as `CC BY-SA 4.0` under a picture. */
function licenceOf(license: string | undefined, version: string | undefined): string {
  if (!license) return 'openly licensed — see source';
  const name = license.toUpperCase();
  const prefix = /^(CC0|PDM)$/.test(name) ? '' : 'CC ';
  return `${prefix}${name}${version ? ` ${version}` : ''}`.trim();
}

function aspectFor(orientation: 'landscape' | 'portrait' | 'square'): string {
  return orientation === 'square' ? 'square' : orientation === 'portrait' ? 'tall' : 'wide';
}
