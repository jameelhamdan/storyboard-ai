import { createHash } from 'node:crypto';
import type { EmbeddingPort } from '@application/pipeline/stage/ConsolidateContentStage.js';

/**
 * A hashed bag-of-words vector. Deterministic, offline, and genuinely useful for
 * dedupe: near-identical text produces near-identical vectors, which is the one
 * property consolidation actually depends on.
 *
 * It has no semantic understanding, so it will miss paraphrases that `bge-m3`
 * would catch. That is a recall gap, not a correctness one — a missed duplicate
 * costs a repeated sentence, never a wrong citation.
 */
export class StubEmbedder implements EmbeddingPort {
  private static readonly DIMENSIONS = 256;

  public async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map((text) => this.vectorise(text));
  }

  private vectorise(text: string): number[] {
    const vector = new Array<number>(StubEmbedder.DIMENSIONS).fill(0);
    const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);

    for (const word of words) {
      const digest = createHash('sha256').update(word).digest();
      const bucket = digest.readUInt16BE(0) % StubEmbedder.DIMENSIONS;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }

    // L2-normalise so cosine similarity behaves as the consolidator expects.
    const norm = Math.sqrt(vector.reduce((total, v) => total + v * v, 0));
    return norm === 0 ? vector : vector.map((v) => v / norm);
  }
}
