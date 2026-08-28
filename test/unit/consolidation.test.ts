import { describe, it, expect } from 'vitest';
import { ConsolidateContentStage } from '@application/pipeline/stage/ConsolidateContentStage.js';
import { StubEmbedder } from '@infrastructure/stub/StubEmbedder.js';
import { SourceDocument } from '@domain/content/SourceDocument.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { SourcePrecedencePolicy } from '@domain/policy/SourcePrecedencePolicy.js';
import { InsufficientContentError } from '@domain/error/InsufficientContentError.js';
import type { PipelineContext } from '@application/pipeline/PipelineContext.js';
import type { SourceKind } from '@domain/content/ContentChunk.js';

const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, child: () => logger } as unknown as PipelineContext['logger'];

function ctx(overrides: { minWords?: number; minConcepts?: number; threshold?: number } = {}): PipelineContext {
  return {
    config: {
      content: {
        minWords: overrides.minWords ?? 10,
        minDistinctConcepts: overrides.minConcepts ?? 1,
        dedupeSimilarityThreshold: overrides.threshold ?? 0.92,
        sourcePrecedence: ['typed_document', 'slides', 'transcript', 'ocr_photo'],
      },
      policies: {
        sourcePrecedence: new SourcePrecedencePolicy(['typed_document', 'slides', 'transcript', 'ocr_photo']),
      },
    },
    logger,
    signal: new AbortController().signal,
    throwIfCancelled: noop,
    reportProgress: noop,
  } as unknown as PipelineContext;
}

const doc = (id: string, texts: string[], kind: SourceKind = 'typed_document') =>
  SourceDocument.of({
    id, origin: { type: 'file', filename: `${id}.pdf`, mimeType: 'application/pdf', bytes: 1 },
    kind,
    chunks: texts.map((text, i) => ContentChunk.of({
      id: `${id}:${i}`, text, refs: [SourceRef.page(id, i + 1)], kind, order: i,
    })),
  });

const stage = new ConsolidateContentStage(new StubEmbedder());
const run = async (documents: SourceDocument[], c = ctx()) =>
  (await stage.execute({ documents, audioSecondsTranscribed: 0 }, c)).content;

describe('ConsolidateContentStage', () => {
  it('rejects an empty set with INSUFFICIENT_CONTENT rather than a generic error', async () => {
    await expect(run([])).rejects.toBeInstanceOf(InsufficientContentError);
  });

  it('enforces the word floor on deduplicated content, not raw upload size', async () => {
    // The same sentence forty times is one sentence of content.
    const repeated = Array.from({ length: 40 }, () => 'The mitochondrion is the powerhouse of the cell.');
    await expect(run([doc('d', repeated)], ctx({ minWords: 100 })))
      .rejects.toBeInstanceOf(InsufficientContentError);
  });

  it('merges exact duplicates and keeps both sources cited', async () => {
    const text = 'Photosynthesis converts light into chemical energy stored in glucose molecules.';
    const result = await run([doc('a', [text]), doc('b', [text])]);

    expect(result.stats.chunkCount).toBe(1);
    expect(result.stats.duplicatesMerged).toBe(1);
    expect(result.chunks[0]!.refs.map((r) => r.sourceId).sort()).toEqual(['a', 'b']);
  });

  it('keeps genuinely different content separate', async () => {
    const result = await run([doc('a', [
      'Photosynthesis converts light energy into chemical energy in plants.',
      'Cellular respiration releases that stored energy for the cell to use.',
    ])]);
    expect(result.stats.chunkCount).toBe(2);
  });

  it('renumbers surviving chunks contiguously from zero', async () => {
    const result = await run([doc('a', [
      'Alpha content about photosynthesis and the light dependent reactions here.',
      'Beta content about cellular respiration and the electron transport chain.',
      'Gamma content about fermentation pathways when oxygen is unavailable now.',
    ])]);
    expect(result.chunks.map((c) => c.order)).toEqual([0, 1, 2]);
  });

  it('prefers the typed document when two sources say the same thing', async () => {
    const text = 'The Calvin cycle fixes carbon dioxide into three carbon sugars.';
    const result = await run([doc('photo', [text], 'ocr_photo'), doc('typed', [text], 'typed_document')]);

    expect(result.chunks[0]!.kind).toBe('typed_document');
    // The loser is recorded, not silently discarded.
    expect(result.chunks[0]!.refs.map((r) => r.sourceId).sort()).toEqual(['photo', 'typed']);
  });

  it('reports volume statistics that reflect the merged result', async () => {
    const result = await run([doc('a', [
      'Alpha content about photosynthesis and the light dependent reactions here.',
      'Beta content about cellular respiration and the electron transport chain.',
    ])]);

    expect(result.stats.sourceCount).toBe(1);
    expect(result.stats.totalWords).toBe(result.chunks.reduce((t, c) => t + c.wordCount, 0));
    expect(result.stats.distinctConcepts).toBeGreaterThan(0);
  });
});

describe('StubEmbedder', () => {
  const embedder = new StubEmbedder();

  it('produces unit-length vectors, so cosine similarity is well behaved', async () => {
    const [v] = await embedder.embed(['some words here about photosynthesis']);
    const norm = Math.sqrt(v!.reduce((t, x) => t + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('scores identical text as identical', async () => {
    const [a, b] = await embedder.embed(['the same text', 'the same text']);
    const dot = a!.reduce((t, x, i) => t + x * b![i]!, 0);
    expect(dot).toBeCloseTo(1, 6);
  });

  it('scores unrelated text lower than related text', async () => {
    const [a, b, c] = await embedder.embed([
      'photosynthesis light reactions chlorophyll thylakoid',
      'photosynthesis light reactions chlorophyll membrane',
      'quarterly revenue forecast shareholder dividend',
    ]);
    const cos = (x: readonly number[], y: readonly number[]) => x.reduce((t, v, i) => t + v * y[i]!, 0);
    expect(cos(a!, b!)).toBeGreaterThan(cos(a!, c!));
  });

  it('returns an all-zero vector for text with no usable words rather than NaN', async () => {
    const [v] = await embedder.embed(['...']);
    expect(v!.every((x) => Number.isFinite(x))).toBe(true);
  });
});
