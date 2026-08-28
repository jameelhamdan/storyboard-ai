import type { WebSearchPort, SearchHit } from '@application/port/WebSearchPort.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';

export interface GeminiSearchOptions {
  readonly apiKey: string;
  /** A model that supports the `google_search` tool. */
  readonly model: string;
  readonly requestTimeoutMs: number;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

interface GroundedResponse {
  readonly candidates?: readonly {
    readonly groundingMetadata?: {
      readonly webSearchQueries?: readonly string[];
      readonly groundingChunks?: readonly {
        readonly web?: { readonly uri?: string; readonly title?: string };
      }[];
    };
  }[];
}

/**
 * Web search via Gemini's own `google_search` tool.
 *
 * The reason this exists rather than only a search-API adapter: it needs **no
 * new credential**. A deployment already on `LLM_DRIVER=gemini` can research a
 * topic today, and research is the feature most likely to be tried once and
 * turned off — asking someone to sign up for a search API before they can
 * evaluate it is how a feature never gets evaluated.
 *
 * Two properties worth knowing:
 *
 * 1. **The model decides whether to search.** Asked a question it already knows,
 *    it answers from memory and returns no grounding at all. So the prompt here
 *    instructs it to search explicitly — verified: without that instruction a
 *    stomata query returned zero grounding chunks, and with it, nine.
 * 2. **The URLs are redirects** through `vertexaisearch.cloud.google.com`. They
 *    resolve to the real page, and `SafeHttpClient` re-validates every hop, so
 *    the SSRF guard covers the redirect chain rather than just the first URL.
 *
 * The model's *answer* is discarded on purpose. Only the URLs are kept, and they
 * go through the ordinary extraction path — which is what makes a researched
 * fact exactly as citable as one from an uploaded PDF. Taking the answer instead
 * would import a claim with no source attached to it.
 */
export class GeminiGroundedSearch implements WebSearchPort {
  public readonly name = 'gemini';
  private readonly baseUrl: string;

  constructor(
    private readonly options: GeminiSearchOptions,
    private readonly logger: LoggerPort,
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  public async search(input: {
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<readonly SearchHit[]> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);

    const response = await fetch(
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.options.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': this.options.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{
              text: `Use the search tool to find the most authoritative pages about: ${input.query}. `
                + 'Prefer teaching material, encyclopaedic references and primary sources.',
            }],
          }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0, maxOutputTokens: 1024 },
        }),
        signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable>');
      throw new Error(`Gemini search failed: ${response.status} ${detail.slice(0, 300)}`);
    }

    const body = (await response.json()) as GroundedResponse;
    const metadata = body.candidates?.[0]?.groundingMetadata;
    const chunks = metadata?.groundingChunks ?? [];

    if (chunks.length === 0) {
      // Not an error: the model judged that it did not need to look anything up.
      // Loud, because "research found nothing" and "research did not happen" look
      // identical from the stage above and call for different responses.
      this.logger.warn({ query: input.query }, 'grounded search returned no sources; the model did not search');
    }

    return chunks
      .map((chunk) => chunk.web)
      .filter((web): web is { uri: string; title: string } => Boolean(web?.uri))
      .map((web) => ({
        url: web.uri,
        // Grounding returns the domain as the title. It is what there is, and it
        // is enough to deduplicate and to log.
        title: web.title ?? web.uri,
        snippet: '',
      }))
      .slice(0, input.limit);
  }
}
