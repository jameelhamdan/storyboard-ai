import type { ContentChunk } from './ContentChunk.js';
import type { Language } from '../shared/Language.js';

export interface ConsolidationConflict {
  readonly topic: string;
  readonly winningChunkId: string;
  readonly discardedChunkIds: readonly string[];
  readonly reason: string;
}

export interface VolumeStatistics {
  readonly totalWords: number;
  readonly distinctConcepts: number;
  readonly chunkCount: number;
  readonly duplicatesMerged: number;
  readonly sourceCount: number;
}

/**
 * Deduplicated, ordered chunks plus the volume statistics that DurationPolicy and
 * the INSUFFICIENT_CONTENT threshold actually measure. Both read *this*, never raw
 * upload size — 40 pages of the same slide is not 40 pages of content.
 */
export class ConsolidatedContent {
  private constructor(
    public readonly chunks: readonly ContentChunk[],
    public readonly stats: VolumeStatistics,
    public readonly conflicts: readonly ConsolidationConflict[],
    public readonly languages: readonly Language[],
  ) {}

  public static of(input: {
    chunks: readonly ContentChunk[];
    duplicatesMerged: number;
    sourceCount: number;
    distinctConcepts: number;
    conflicts?: readonly ConsolidationConflict[];
  }): ConsolidatedContent {
    const ordered = [...input.chunks].sort((a, b) => a.order - b.order);
    const languages = [
      ...new Map(
        ordered
          .map((c) => c.detectedLanguage)
          .filter((l): l is Language => l !== undefined)
          .map((l) => [l.code, l]),
      ).values(),
    ];
    return new ConsolidatedContent(
      ordered,
      {
        totalWords: ordered.reduce((t, c) => t + c.wordCount, 0),
        distinctConcepts: input.distinctConcepts,
        chunkCount: ordered.length,
        duplicatesMerged: input.duplicatesMerged,
        sourceCount: input.sourceCount,
      },
      input.conflicts ?? [],
      languages,
    );
  }

  public get text(): string {
    return this.chunks.map((c) => c.text).join('\n\n');
  }

  /** True when any chunk is in a language other than the requested output. */
  public requiresTranslation(outputLanguage: Language): boolean {
    return this.languages.some((l) => !l.equals(outputLanguage));
  }
}
