import type { WebSearchPort, SearchHit } from '@application/port/WebSearchPort.js';

export interface BraveSearchOptions {
  readonly apiKey: string;
  readonly requestTimeoutMs: number;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.search.brave.com';

interface WebResponse {
  readonly web?: {
    readonly results?: readonly {
      readonly url?: string;
      readonly title?: string;
      readonly description?: string;
    }[];
  };
}

interface ImageResponse {
  readonly results?: readonly {
    readonly title?: string;
    readonly url?: string;
    readonly source?: string;
    readonly properties?: { readonly url?: string };
    readonly meta_url?: { readonly netloc?: string };
  }[];
}

/**
 * One client, two endpoints: Brave answers both web and image search.
 *
 * Shared rather than split into two adapters with their own auth and error
 * handling, because there is exactly one credential and one failure shape. The
 * two *ports* stay separate — `BraveWebSearch` for research and
 * `BraveImageSource` for boards — since their callers want entirely different
 * things back.
 *
 * Chosen over Google Programmable Search for one reason worth writing down: CSE
 * needs a key *and* a search-engine id, and its image results are scoped to
 * whatever sites that engine was configured for. A general web search
 * configured through a console is a footgun for a service that is supposed to
 * search the open web.
 */
export class BraveSearchClient {
  private readonly baseUrl: string;

  constructor(private readonly options: BraveSearchOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  public async web(query: string, limit: number, signal?: AbortSignal): Promise<readonly SearchHit[]> {
    const url = new URL(`${this.baseUrl}/res/v1/web/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(limit, 20)));

    const body = (await this.get(url, signal)) as WebResponse;

    return (body.web?.results ?? [])
      .filter((result): result is { url: string; title?: string; description?: string } => Boolean(result.url))
      .map((result) => ({
        url: result.url,
        title: result.title ?? result.url,
        snippet: result.description ?? '',
      }))
      .slice(0, limit);
  }

  /**
   * Image results, licence-filtered.
   *
   * The filter is not optional and not a setting. Everything else this service
   * puts on a board comes from a library whose licence it can state — Commons,
   * Unsplash, Pexels all publish one — and an unfiltered web image has no
   * licence anyone can name. A picture we cannot credit is a picture we cannot
   * use, so the filter is applied at the query and the result still carries the
   * host as its attribution.
   */
  public async images(query: string, limit: number, signal?: AbortSignal): Promise<readonly {
    url: string; title: string; host: string;
  }[]> {
    const url = new URL(`${this.baseUrl}/res/v1/images/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(limit, 20)));
    url.searchParams.set('safesearch', 'strict');

    const body = (await this.get(url, signal)) as ImageResponse;

    return (body.results ?? [])
      .map((result) => ({
        url: result.properties?.url ?? '',
        title: result.title ?? '',
        host: result.meta_url?.netloc ?? result.source ?? 'the web',
      }))
      .filter((result) => result.url.startsWith('http'))
      .slice(0, limit);
  }

  private async get(url: URL, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const response = await fetch(url, {
      headers: {
        'x-subscription-token': this.options.apiKey,
        accept: 'application/json',
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable>');
      throw new Error(`Brave search failed: ${response.status} ${detail.slice(0, 200)}`);
    }
    return response.json();
  }
}

/** The research half. */
export class BraveWebSearch implements WebSearchPort {
  public readonly name = 'brave';

  constructor(private readonly client: BraveSearchClient) {}

  public search(input: {
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<readonly SearchHit[]> {
    return this.client.web(input.query, input.limit, input.signal);
  }
}
