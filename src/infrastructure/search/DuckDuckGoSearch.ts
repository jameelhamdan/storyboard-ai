import { parseHTML } from 'linkedom';
import type { WebSearchPort, SearchHit } from '@application/port/WebSearchPort.js';

export interface DuckDuckGoOptions {
  readonly requestTimeoutMs: number;
  /** Sent on every request; a search engine is entitled to know who is asking. */
  readonly userAgent: string;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://html.duckduckgo.com';

/**
 * Web search with no API key at all.
 *
 * This is the option that makes research usable without signing up for
 * anything: Brave wants a key, Google's Programmable Search wants a key *and* a
 * search-engine id, and Gemini's grounding wants a Gemini key. DuckDuckGo's
 * no-JavaScript endpoint wants nothing.
 *
 * **What that costs is robustness, and it is worth saying plainly.** This parses
 * a page meant for a browser rather than reading a documented API, so a markup
 * change breaks it and no version number will warn us. It is therefore treated
 * as the *degradable* driver: a parse that finds nothing returns nothing, the
 * research stage logs it and carries on with the caller's own material, and the
 * job still produces a video. Anything that must not silently degrade should use
 * a keyed driver.
 *
 * Results are rate-limited by the engine rather than by us. The research policy
 * already bounds queries per round, which is what keeps this polite.
 */
export class DuckDuckGoSearch implements WebSearchPort {
  public readonly name = 'duckduckgo';
  private readonly baseUrl: string;

  constructor(private readonly options: DuckDuckGoOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  public async search(input: {
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<readonly SearchHit[]> {
    const url = new URL(`${this.baseUrl}/html/`);
    url.searchParams.set('q', input.query);

    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const response = await fetch(url, {
      headers: { 'user-agent': this.options.userAgent, accept: 'text/html' },
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo search failed: ${response.status}`);
    }

    const { document } = parseHTML(await response.text());
    const hits: SearchHit[] = [];

    for (const anchor of [...document.querySelectorAll('a.result__a')]) {
      const url = resolveRedirect(anchor.getAttribute('href'));
      if (!url) continue;

      hits.push({
        url,
        title: (anchor.textContent ?? '').trim() || url,
        // The engine's own extract, which is what makes a later round able to
        // say what is still missing without fetching every page first.
        snippet: (anchor.closest('.result')?.querySelector('.result__snippet')?.textContent ?? '').trim(),
      });
      if (hits.length >= input.limit) break;
    }

    return hits;
  }
}

/**
 * Results are wrapped in `//duckduckgo.com/l/?uddg=<encoded>`, so the href is a
 * redirect rather than the page.
 *
 * Unwrapped here rather than followed, because the pipeline's whole guarantee is
 * that a source names where it came from: `cleveland clinic` in a citation is
 * worth something and `duckduckgo.com/l/` is worth nothing. It also spares the
 * SSRF guard a hop it would otherwise have to validate.
 */
function resolveRedirect(href: string | null): string | undefined {
  if (!href) return undefined;

  try {
    // The href is protocol-relative, so it needs a base to parse against.
    const parsed = new URL(href, 'https://duckduckgo.com');
    const target = parsed.searchParams.get('uddg');
    const resolved = target ?? parsed.href;

    // A result that is not an ordinary web page is not a source.
    return /^https?:\/\//.test(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}
