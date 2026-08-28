export interface SearchHit {
  readonly url: string;
  readonly title: string;
  /** The engine's own extract. Enough to judge relevance without fetching. */
  readonly snippet: string;
}

/**
 * Finds pages about a topic.
 *
 * Text results only. Image search is not on this port — it is an
 * `ImageSourcePort`, because a found image has to be fetched, resized, inlined
 * and credited before anything can use it, and none of that is what a research
 * caller wants. One infrastructure client can serve both; one interface serving
 * both would give each caller a method it has no use for.
 *
 * What comes back is a list of *URLs to consider*, never content. The pipeline
 * already knows how to turn a URL into cited, provenance-carrying chunks —
 * `WebPageExtractor` behind the SSRF guard — and reusing that path is what keeps
 * a researched fact as traceable as one from an uploaded PDF.
 */
export interface WebSearchPort {
  /** The engine's name, for the boot log and the cost report. */
  readonly name: string;

  search(input: {
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<readonly SearchHit[]>;
}
