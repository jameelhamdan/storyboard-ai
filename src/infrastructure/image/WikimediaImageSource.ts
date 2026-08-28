import type { ImageSourcePort, ImageQuery } from '@application/port/ImageSourcePort.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';
import type { SceneImage } from '@domain/media/SceneImage.js';
import { fetchImageBytes } from './fetchBytes.js';
import { inlineImage } from './inlineImage.js';

export interface WikimediaOptions {
  readonly requestTimeoutMs: number;
  /** Wikimedia's policy requires a real contact in the User-Agent. */
  readonly userAgent: string;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://commons.wikimedia.org';

interface ExtMetadata {
  readonly Artist?: { readonly value?: string };
  readonly LicenseShortName?: { readonly value?: string };
  readonly ImageDescription?: { readonly value?: string };
}

interface QueryResponse {
  readonly query?: {
    readonly pages?: Record<string, {
      readonly title?: string;
      readonly imageinfo?: readonly {
        readonly thumburl?: string;
        readonly url?: string;
        readonly descriptionurl?: string;
        readonly extmetadata?: ExtMetadata;
      }[];
    }>;
  };
}

/**
 * Wikimedia Commons: where the scientific diagrams actually are.
 *
 * This is the source that makes `kind: 'diagram'` mean something. A stock
 * library has no picture of the Krebs cycle, the visible spectrum or a
 * four-stroke engine cycle; Commons has all three, drawn properly, in a dozen
 * languages, and free to use with credit. It answers photo queries too, less
 * well, which is why the composite tries it first only for diagrams.
 *
 * Three things are specific to this source and worth stating:
 *
 * - **It is asked for a rendered thumbnail** (`iiurlwidth`), not the original.
 *   Half of Commons' diagrams are SVG, and the rasterisation MediaWiki already
 *   does is better than anything done downstream of a file with unresolved font
 *   references.
 * - **The credit comes back as HTML** — `Artist` is a link, not a name — so it
 *   is stripped rather than rendered. A board is not a place to run someone
 *   else's markup.
 * - **A User-Agent identifying the service is required by policy**, and requests
 *   without one are throttled or blocked outright.
 */
export class WikimediaImageSource implements ImageSourcePort {
  public readonly id: ImageSourceId = 'wikimedia';
  private readonly baseUrl: string;

  constructor(private readonly options: WikimediaOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  public async find(query: ImageQuery): Promise<SceneImage | undefined> {
    const url = new URL(`${this.baseUrl}/w/api.php`);
    const params: Record<string, string> = {
      action: 'query',
      format: 'json',
      generator: 'search',
      // Namespace 6 is File:, and `filetype:bitmap|drawing` keeps videos, audio
      // and PDFs — all of which live in the same namespace — out of the results.
      gsrnamespace: '6',
      gsrsearch: `${query.query} filetype:bitmap|drawing`,
      gsrlimit: '8',
      prop: 'imageinfo',
      iiprop: 'url|extmetadata',
      iiurlwidth: '1100',
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const response = await fetch(url, {
      headers: { 'user-agent': this.options.userAgent, accept: 'application/json' },
      signal: query.signal ? AbortSignal.any([query.signal, timeout]) : timeout,
    });
    if (!response.ok) {
      throw new Error(`Wikimedia search failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }

    const body = (await response.json()) as QueryResponse;

    for (const page of Object.values(body.query?.pages ?? {})) {
      const info = page.imageinfo?.[0];
      const source = info?.thumburl ?? info?.url;
      if (!source) continue;

      const meta = info?.extmetadata;
      const author = stripHtml(meta?.Artist?.value) || 'Wikimedia Commons contributors';
      const licence = stripHtml(meta?.LicenseShortName?.value) || 'see source';

      return inlineImage({
        source: 'wikimedia',
        bytes: await fetchImageBytes(source, this.options.requestTimeoutMs, query.signal),
        alt: stripHtml(meta?.ImageDescription?.value)
          || (page.title ?? '').replace(/^File:/, '').replace(/\.[a-z]+$/i, '')
          || query.query,
        attribution: {
          author,
          sourceName: 'Wikimedia Commons',
          sourceUrl: info?.descriptionurl ?? this.baseUrl,
          licence,
        },
      });
    }
    return undefined;
  }
}

/**
 * Commons returns credit and description as HTML fragments. They are displayed
 * as text on a board, so the tags are removed rather than escaped — and the
 * result is trimmed hard, because an `ImageDescription` can be three paragraphs
 * and the alt text has room for a phrase.
 */
function stripHtml(value: string | undefined): string {
  const text = (value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  /**
   * Commons often puts the same name in a `title` attribute *and* in the link
   * text, so stripping the tags leaves "Unknown author Unknown author" — which
   * is what a real search returned and what would have been printed under the
   * picture.
   */
  const halves = text.match(/^(.+?)\s+\1$/);
  return (halves?.[1] ?? text).slice(0, 180);
}
