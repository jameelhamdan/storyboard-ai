import { DomainError, type DomainErrorCode } from './DomainError.js';

/**
 * Raised after consolidation, on deduplicated content — never on raw upload size.
 * A 40-page PDF that is 39 pages of the same slide is insufficient content.
 */
export class InsufficientContentError extends DomainError {
  public readonly code: DomainErrorCode = 'INSUFFICIENT_CONTENT';

  constructor(
    public readonly wordCount: number,
    public readonly requiredWords: number,
    public readonly distinctConcepts?: number,
    public readonly requiredConcepts?: number,
  ) {
    super(
      `Provided material contains ${wordCount} usable words; ${requiredWords} required.`,
      { word_count: wordCount, required: requiredWords, distinct_concepts: distinctConcepts, required_concepts: requiredConcepts },
    );
  }
}
