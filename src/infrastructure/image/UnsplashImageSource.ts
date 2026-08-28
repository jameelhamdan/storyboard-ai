import type { ImageSourcePort, ImageQuery } from '@application/port/ImageSourcePort.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';
import type { SceneImage } from '@domain/media/SceneImage.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import { fetchImageBytes } from './fetchBytes.js';
import { inlineImage } from './inlineImage.js';

export interface UnsplashOptions {
  readonly accessKey: string;
  readonly requestTimeoutMs: number;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.unsplash.com';

interface SearchResponse {
  readonly results?: readonly {
    readonly description?: string | null;
    readonly alt_description?: string | null;
    readonly urls?: { readonly regular?: string };
    readonly links?: { readonly html?: string; readonly download_location?: string };
    readonly user?: { readonly name?: string };
  }[];
}

/**
 * Unsplash: photographs, and only photographs.
 *
 * It has excellent pictures of objects, places and materials and essentially no
 * scientific diagrams — a search for "Krebs cycle" returns a laboratory bench.
 * So it declines `kind: 'diagram'` outright rather than returning something
 * plausible-looking and wrong, which is the failure mode that makes an
 * illustrated board worse than a drawn one.
 *
 * **The download trigger is a licence term, not an optimisation.** Unsplash
 * requires that using an image pings its `download_location`; it is how
 * photographers are credited with usage. It is fired and not awaited for the
 * result — a failure there must not cost us the picture — but it is fired.
 */
export class UnsplashImageSource implements ImageSourcePort {
  public readonly id: ImageSourceId = 'unsplash';
  private readonly baseUrl: string;

  constructor(
    private readonly options: UnsplashOptions,
    private readonly logger: LoggerPort,
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  public async find(query: ImageQuery): Promise<SceneImage | undefined> {
    if (query.kind === 'diagram') return undefined;

    const url = new URL(`${this.baseUrl}/search/photos`);
    url.searchParams.set('query', query.query);
    url.searchParams.set('per_page', '5');
    url.searchParams.set('content_filter', 'high');
    if (query.orientation) url.searchParams.set('orientation', query.orientation);

    const response = await this.request(url, query.signal);
    const body = (await response.json()) as SearchResponse;

    for (const result of body.results ?? []) {
      const source = result.urls?.regular;
      const author = result.user?.name;
      if (!source || !author) continue;

      const bytes = await fetchImageBytes(source, this.options.requestTimeoutMs, query.signal);
      this.trigger(result.links?.download_location);

      return inlineImage({
        source: 'unsplash',
        bytes,
        alt: result.description ?? result.alt_description ?? query.query,
        attribution: {
          author,
          sourceName: 'Unsplash',
          sourceUrl: result.links?.html ?? 'https://unsplash.com',
          licence: 'Unsplash License',
        },
      });
    }
    return undefined;
  }

  private trigger(downloadLocation: string | undefined): void {
    if (!downloadLocation) return;
    this.request(new URL(downloadLocation)).catch((error: unknown) => {
      this.logger.debug({ err: error }, 'unsplash download trigger failed');
    });
  }

  private async request(url: URL, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const response = await fetch(url, {
      headers: { authorization: `Client-ID ${this.options.accessKey}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      throw new Error(`Unsplash search failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    return response;
  }
}
