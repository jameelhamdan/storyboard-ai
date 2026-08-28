import type { ImageSourcePort, ImageQuery } from '@application/port/ImageSourcePort.js';
import type { SceneImage } from '@domain/media/SceneImage.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';
import type { BraveSearchClient } from '../search/BraveSearchClient.js';
import { fetchImageBytes } from './fetchBytes.js';
import { inlineImage } from './inlineImage.js';

export interface WebSearchImageOptions {
  readonly requestTimeoutMs: number;
}

/**
 * The open web as a last-resort library.
 *
 * It has the widest coverage and the weakest licensing story, which is exactly
 * why it sits behind the three curated libraries in `ImageSourcePolicy` rather
 * than ahead of them: Commons, Unsplash and Pexels each publish a licence this
 * service can print under the picture, and a web result does not.
 *
 * What it can honestly say is *where the picture came from*, so that is what the
 * credit line carries — the host, named, with the page it was found on. That is
 * weaker than a licence and it is stated as such rather than dressed up as one.
 *
 * A result that cannot be fetched or decoded is skipped rather than failing the
 * search: unlike an API library, a web result is a URL on someone else's server
 * that may be gone, hotlink-protected or not an image at all.
 */
export class WebSearchImageSource implements ImageSourcePort {
  public readonly id: ImageSourceId = 'web_search';

  constructor(
    private readonly client: BraveSearchClient,
    private readonly options: WebSearchImageOptions,
  ) {}

  public async find(query: ImageQuery): Promise<SceneImage | undefined> {
    const results = await this.client.images(query.query, 6, query.signal);

    for (const result of results) {
      try {
        const bytes = await fetchImageBytes(result.url, this.options.requestTimeoutMs, query.signal);

        return await inlineImage({
          bytes,
          alt: result.title || query.query,
          attribution: {
            author: result.host,
            sourceName: 'the web',
            sourceUrl: result.url,
            licence: 'licence not stated — check before publishing',
          },
          source: 'web_search',
        });
      } catch {
        // Gone, hotlink-protected, or not an image. Try the next result.
        continue;
      }
    }
    return undefined;
  }
}
