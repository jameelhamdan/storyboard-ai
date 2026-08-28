import type { ContentChunk, SourceKind } from '../content/ContentChunk.js';
import type { ConsolidationConflict } from '../content/ConsolidatedContent.js';

/**
 * Where sources disagree, prefer the higher-fidelity one — and *flag* the
 * disagreement rather than silently discarding the loser. A photo of a slide that
 * contradicts the typed handout is usually an OCR error, but it is occasionally the
 * handout being wrong, and that is StudyCore's call to make, not ours.
 */
export class SourcePrecedencePolicy {
  private readonly rank: Map<SourceKind, number>;

  constructor(precedence: readonly SourceKind[]) {
    this.rank = new Map(precedence.map((kind, i) => [kind, i]));
  }

  private rankOf(kind: SourceKind): number {
    return this.rank.get(kind) ?? Number.MAX_SAFE_INTEGER;
  }

  public outranks(a: ContentChunk, b: ContentChunk): boolean {
    return this.rankOf(a.kind) < this.rankOf(b.kind);
  }

  /** Winner keeps every contributing citation; losers are recorded, not deleted. */
  public resolve(topic: string, candidates: readonly ContentChunk[]): {
    winner: ContentChunk;
    conflict: ConsolidationConflict | undefined;
  } {
    if (candidates.length === 0) throw new RangeError('resolve() called with no candidates.');

    const sorted = [...candidates].sort((a, b) => this.rankOf(a.kind) - this.rankOf(b.kind));
    const winner = sorted[0]!;
    const losers = sorted.slice(1);

    const merged = losers.reduce((acc, loser) => acc.mergedWith(loser), winner);

    if (losers.length === 0) return { winner: merged, conflict: undefined };

    return {
      winner: merged,
      conflict: {
        topic,
        winningChunkId: winner.id,
        discardedChunkIds: losers.map((l) => l.id),
        reason: `'${winner.kind}' outranks ${losers.map((l) => `'${l.kind}'`).join(', ')}`,
      },
    };
  }
}
