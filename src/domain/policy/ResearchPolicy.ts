/**
 * How much of the open web a job may pull in, and when to stop.
 *
 * Research is the one part of this pipeline with no natural end: there is always
 * another page, and a model asked "what is still missing" will always find
 * something. So the bounds are stated here rather than discovered at runtime —
 * the same reason `RetryBudgetPolicy` exists.
 *
 * The limits are about *grounding*, not cost. A video built from thirty web
 * pages is not better researched than one built from six; it is a video whose
 * citations nobody will check, assembled from sources nobody chose. Six good
 * pages is a reading list. Thirty is a search results page.
 */
export interface ResearchLimits {
  /** Search rounds. One is a search; more than one is deep research. */
  readonly maxRounds: number;
  readonly queriesPerRound: number;
  /** Pages actually fetched and ingested, across every round. */
  readonly maxSources: number;
}

export type ResearchMode = 'none' | 'web_search' | 'deep';

export class ResearchPolicy {
  constructor(private readonly limits: ResearchLimits) {}

  /**
   * `web_search` is deliberately one round.
   *
   * It is the cheap mode: search what the caller asked about, read the best few
   * results, write the script. `deep` is what re-enters the loop after asking
   * the quality tier what the material still does not answer — which is a real
   * capability and a real bill, and the difference between the two should be a
   * decision somebody made rather than a threshold something crossed.
   */
  public roundsFor(mode: ResearchMode): number {
    if (mode === 'none') return 0;
    return mode === 'deep' ? Math.max(1, this.limits.maxRounds) : 1;
  }

  public get queriesPerRound(): number {
    return this.limits.queriesPerRound;
  }

  /** How many more pages may be taken, given what is already in hand. */
  public remainingSources(alreadyTaken: number): number {
    return Math.max(0, this.limits.maxSources - alreadyTaken);
  }
}
