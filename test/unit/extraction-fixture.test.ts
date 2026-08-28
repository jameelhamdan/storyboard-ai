import { describe, it, expect } from 'vitest';
import { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { Language } from '@domain/shared/Language.js';
import { consolidatedToJson, consolidatedFromJson } from '@application/pipeline/codec.js';
import { CHECKPOINT_KEY } from '@application/pipeline/StageName.js';

/**
 * Mirrors e2e/run.ts's seedExtractionCheckpoints. If the two drift, the harness
 * writes a checkpoint the pipeline cannot read — and the failure would surface
 * as a confusing deserialise error nine stages from the cause.
 */
function buildFixture(text: string): ConsolidatedContent {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const chunks = paragraphs.map((paragraph, i) =>
    ContentChunk.of({
      id: `chunk-${i}`,
      text: paragraph,
      kind: 'typed_document',
      order: i,
      detectedLanguage: Language.of('en'),
      refs: [SourceRef.section('sample-0', `Paragraph ${i + 1}`)],
    }),
  );
  return ConsolidatedContent.of({
    chunks, duplicatesMerged: 0, sourceCount: 1, distinctConcepts: chunks.length,
  });
}

const SAMPLE = `First paragraph about photosynthesis and how it works.

Second paragraph covering the light-dependent reactions in detail.

Third paragraph on the Calvin cycle.`;

describe('the e2e extraction fixture', () => {
  it('round-trips through the consolidate stage codec', () => {
    const original = buildFixture(SAMPLE);
    const restored = consolidatedFromJson(consolidatedToJson(original) as never);

    expect(restored.chunks).toHaveLength(3);
    expect(restored.text).toBe(original.text);
    expect(restored.stats.totalWords).toBe(original.stats.totalWords);
  });

  it('splits on blank lines, one chunk per paragraph', () => {
    expect(buildFixture(SAMPLE).chunks.map((c) => c.order)).toEqual([0, 1, 2]);
  });

  it('gives every chunk resolvable provenance, which source-lock requires', () => {
    // A chunk without refs throws at construction; this asserts the citation
    // actually points somewhere rather than merely existing.
    for (const chunk of buildFixture(SAMPLE).chunks) {
      expect(chunk.refs).not.toHaveLength(0);
      expect(chunk.refs[0]!.sourceId).toBe('sample-0');
      expect(chunk.refs[0]!.locator.kind).toBe('section');
    }
  });

  it('reports a word count that reflects the real text', () => {
    const content = buildFixture(SAMPLE);
    expect(content.stats.totalWords).toBe(SAMPLE.split(/\s+/).filter(Boolean).length);
    expect(content.stats.sourceCount).toBe(1);
  });

  it('collapses internal whitespace so anchors match the spoken form', () => {
    const content = buildFixture('Some   text\n   with  odd\n  spacing.');
    expect(content.chunks[0]!.text).toBe('Some text with odd spacing.');
  });

  it('checkpoints to one stable key, so a resuming worker knows where to look', () => {
    expect(CHECKPOINT_KEY).toBe('checkpoint.json');
  });
});
