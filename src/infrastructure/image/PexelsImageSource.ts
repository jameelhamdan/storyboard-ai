import type { ImageSourcePort, ImageQuery } from '@application/port/ImageSourcePort.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';
import type { SceneImage } from '@domain/media/SceneImage.js';
import { fetchImageBytes } from './fetchBytes.js';
import { inlineImage } from './inlineImage.js';

export interface PexelsOptions {
  readonly apiKey: string;
  readonly requestTimeoutMs: number;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.pexels.com';

interface SearchResponse {
  readonly photos?: readonly {
    readonly alt?: string;
    readonly url?: string;
    readonly photographer?: string;
    readonly src?: { readonly large?: string; readonly medium?: string };
  }[];
}

/**
 * Pexels: the second stock library, for the same reason as the first and with
 * the same limitation — photographs only, no diagrams.
 *
 * Carrying two stock sources is not redundancy for its own sake. Their libraries
 * differ enough that a subject one has nothing for the other often does, and a
 * miss is free: `find` returning `undefined` costs one search and moves to the
 * next source.
 */
export class PexelsImageSource implements ImageSourcePort {
  public readonly id: ImageSourceId = 'pexels';
  private readonly baseUrl: string;

  constructor(private readonly options: PexelsOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  public async find(query: ImageQuery): Promise<SceneImage | undefined> {
    if (query.kind === 'diagram') return undefined;

    const url = new URL(`${this.baseUrl}/v1/search`);
    url.searchParams.set('query', query.query);
    url.searchParams.set('per_page', '5');
    if (query.orientation) url.searchParams.set('orientation', query.orientation);

    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const response = await fetch(url, {
      headers: { authorization: this.options.apiKey },
      signal: query.signal ? AbortSignal.any([query.signal, timeout]) : timeout,
    });
    if (!response.ok) {
      throw new Error(`Pexels search failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }

    const body = (await response.json()) as SearchResponse;

    for (const photo of body.photos ?? []) {
      const source = photo.src?.large ?? photo.src?.medium;
      const author = photo.photographer;
      if (!source || !author) continue;

      return inlineImage({
        source: 'pexels',
        bytes: await fetchImageBytes(source, this.options.requestTimeoutMs, query.signal),
        alt: photo.alt?.trim() || query.query,
        attribution: {
          author,
          sourceName: 'Pexels',
          sourceUrl: photo.url ?? 'https://pexels.com',
          licence: 'Pexels License',
        },
      });
    }
    return undefined;
  }
}
