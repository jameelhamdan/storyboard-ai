import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import { ConsolidatedContent, type ConsolidationConflict } from '@domain/content/ConsolidatedContent.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { InsufficientContentError } from '@domain/error/InsufficientContentError.js';
import type { TranscribedSources, ConsolidatedSources } from './types.js';

export interface EmbeddingPort {
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
}

/**
 * Any combination of inputs may arrive in one request, and those inputs
 * routinely overlap — lecture slides plus a recording of that same lecture, or a
 * PDF plus photos of its pages. Without this step the script narrates the same
 * material twice.
 */
export class ConsolidateContentStage implements PipelineStage<TranscribedSources, ConsolidatedSources> {
  public readonly name: StageName = 'consolidate';

  constructor(private readonly embeddings: EmbeddingPort) {}

  public async execute(input: TranscribedSources, ctx: PipelineContext): Promise<ConsolidatedSources> {
    const all = input.documents.flatMap((d) => d.chunks);
    if (all.length === 0) {
      throw new InsufficientContentError(0, ctx.config.content.minWords);
    }

    const { chunks: afterExact, merged: exactMerges, conflicts: exactConflicts } =
      this.mergeExactDuplicates(all, ctx);
    ctx.throwIfCancelled();

    const { chunks, merged: nearMerges, conflicts: nearConflicts } = await this.mergeNearDuplicates(afterExact, ctx);
    const conflicts = [...exactConflicts, ...nearConflicts];

    const ordered = chunks.map((chunk, i) => ContentChunk.of({
      id: chunk.id,
      text: chunk.text,
      refs: chunk.refs,
      kind: chunk.kind,
      ...(chunk.detectedLanguage ? { detectedLanguage: chunk.detectedLanguage } : {}),
      mediaRefs: chunk.mediaRefs,
      order: i,
    }));

    const consolidated = ConsolidatedContent.of({
      chunks: ordered,
      duplicatesMerged: exactMerges + nearMerges,
      sourceCount: input.documents.length,
      distinctConcepts: this.countDistinctConcepts(ordered),
      conflicts,
    });

    this.assertSufficient(consolidated, ctx);

    ctx.logger.info({
      chunks: consolidated.stats.chunkCount,
      words: consolidated.stats.totalWords,
      merged: consolidated.stats.duplicatesMerged,
      conflicts: conflicts.length,
    }, 'content consolidated');

    return { content: consolidated };
  }

  /**
   * The cheap pass: identical normalised text. Runs first because embedding is
   * the expensive step and most real overlap — the same slide uploaded twice, a
   * PDF and a photo of it — is exact once punctuation and case are stripped.
   *
   * Merging goes through SourcePrecedencePolicy rather than "first one wins", so
   * the typed document beats the OCR photo and the loser is recorded as a
   * conflict rather than silently dropped.
   */
  private mergeExactDuplicates(
    chunks: readonly ContentChunk[], ctx: PipelineContext,
  ): { chunks: ContentChunk[]; merged: number; conflicts: ConsolidationConflict[] } {
    const groups = new Map<string, ContentChunk[]>();
    for (const chunk of chunks) {
      const key = chunk.normalisedText;
      const group = groups.get(key);
      if (group) group.push(chunk);
      else groups.set(key, [chunk]);
    }

    return this.collapse([...groups.values()], ctx);
  }

  /**
   * The semantic pass: chunks that say the same thing in different words.
   *
   * Greedy single-link clustering over cosine similarity. Quadratic in the chunk
   * count, which is fine at this scale — a lecture is hundreds of chunks, not
   * millions — and a smarter index would be a real dependency for no measurable
   * gain here.
   */
  private async mergeNearDuplicates(
    chunks: readonly ContentChunk[], ctx: PipelineContext,
  ): Promise<{ chunks: ContentChunk[]; merged: number; conflicts: ConsolidationConflict[] }> {
    if (chunks.length < 2) return { chunks: [...chunks], merged: 0, conflicts: [] };

    const threshold = ctx.config.content.dedupeSimilarityThreshold;
    const vectors = await this.embeddings.embed(chunks.map((c) => c.text), ctx.signal);

    const groups: ContentChunk[][] = [];
    const groupVectors: (readonly number[])[] = [];

    for (const [index, chunk] of chunks.entries()) {
      const vector = vectors[index] ?? [];
      const match = groupVectors.findIndex((existing) => cosine(existing, vector) >= threshold);

      if (match === -1) {
        groups.push([chunk]);
        groupVectors.push(vector);
      } else {
        groups[match]!.push(chunk);
      }
    }

    return this.collapse(groups, ctx);
  }

  /** Reduces each group of equivalent chunks to one survivor plus any conflict. */
  private collapse(
    groups: readonly ContentChunk[][], ctx: PipelineContext,
  ): { chunks: ContentChunk[]; merged: number; conflicts: ConsolidationConflict[] } {
    const precedence = ctx.config.policies.sourcePrecedence;
    const survivors: ContentChunk[] = [];
    const conflicts: ConsolidationConflict[] = [];
    let merged = 0;

    for (const group of groups) {
      if (group.length === 1) {
        survivors.push(group[0]!);
        continue;
      }

      const kinds = new Set(group.map((c) => c.kind));
      const { winner, conflict } = precedence.resolve(group[0]!.text.slice(0, 60), group);

      survivors.push(winner);
      merged += group.length - 1;

      // Only a disagreement *between kinds* is a conflict worth reporting. Two
      // copies of the same typed document are a duplicate, not a contradiction.
      if (conflict && kinds.size > 1) conflicts.push(conflict);
    }

    survivors.sort((a, b) => a.order - b.order);
    return { chunks: survivors, merged, conflicts };
  }

  /**
   * A cheap proxy for "how much is there actually to explain": distinct
   * significant terms across the deduplicated text. It feeds the
   * INSUFFICIENT_CONTENT floor, so it only has to separate "a slide deck" from
   * "one sentence repeated" — not to be a real topic model.
   */
  private countDistinctConcepts(chunks: readonly ContentChunk[]): number {
    const terms = new Set<string>();
    for (const chunk of chunks) {
      for (const word of chunk.normalisedText.split(' ')) {
        if (word.length > 4) terms.add(word);
      }
    }
    return terms.size;
  }

  /**
   * The floor is applied to the *merged* result, which is the whole point: forty
   * copies of one sentence is one sentence of content, and a video generated from
   * it would be forty seconds of the model inventing the rest.
   */
  private assertSufficient(content: ConsolidatedContent, ctx: PipelineContext): void {
    const { minWords, minDistinctConcepts } = ctx.config.content;
    const { totalWords, distinctConcepts } = content.stats;

    if (totalWords < minWords || distinctConcepts < minDistinctConcepts) {
      throw new InsufficientContentError(totalWords, minWords, distinctConcepts, minDistinctConcepts);
    }
  }
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i]!, y = b[i]!;
    dot += x * y; na += x * x; nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
