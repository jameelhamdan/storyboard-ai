import { describe, it, expect } from 'vitest';
import { carryToJson, carryFromJson } from '@application/pipeline/codec.js';
import { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { QualityPreset } from '@domain/media/QualityPreset.js';

const preset = QualityPreset.of({ name: 'standard', width: 1280, height: 720, fps: 24, codec: 'h264', crf: 23 });

const content = ConsolidatedContent.of({
  chunks: [
    ContentChunk.of({
      id: 'c0', text: 'Photosynthesis converts light into chemical energy.',
      refs: [SourceRef.page('src', 1)], kind: 'typed_document', order: 0,
    }),
  ],
  duplicatesMerged: 0, sourceCount: 1, distinctConcepts: 4,
});

/**
 * The checkpoint is the resume, so a field the codec does not recognise is not a
 * cosmetic loss — it is a job that restarts from nothing after re-reading a
 * checkpoint that looked valid.
 *
 * This is a regression test. The consolidated content used to travel between
 * stages as a bare domain object rather than a named field, so `carryToJson`
 * had nothing to key it by, wrote `{}`, and the resumed script stage crashed on
 * undefined chunks.
 */
describe('checkpoint carry codec', () => {
  it('round-trips the consolidated content a resumed script stage needs', () => {
    const restored = carryFromJson(
      JSON.parse(JSON.stringify(carryToJson({ content }))), preset, 400,
    ) as { content?: ConsolidatedContent };

    expect(restored.content).toBeInstanceOf(ConsolidatedContent);
    expect(restored.content!.chunks).toHaveLength(1);
    expect(restored.content!.stats.totalWords).toBe(content.stats.totalWords);
    expect(restored.content!.chunks[0]!.refs[0]!.sourceId).toBe('src');
  });

  it('keeps the plain bookkeeping fields the later stages read', () => {
    const carry = {
      content,
      audioKey: '07-audio/narration.wav',
      totalAudioMs: 91_500,
      subtitleKey: '11-subtitles/subtitles.srt',
      segmentKeys: ['09-segments/seg-000.mp4'],
      renderWallSeconds: 12.5,
      videoKey: '10-video/video.mp4',
      durationSeconds: 91.5,
      sizeBytes: 4_000_000,
    };

    const restored = carryFromJson(
      JSON.parse(JSON.stringify(carryToJson(carry))), preset, 400,
    ) as Record<string, unknown>;

    for (const [key, value] of Object.entries(carry)) {
      if (key === 'content') continue;
      expect(restored[key], `${key} was dropped by the checkpoint codec`).toEqual(value);
    }
  });

  /**
   * Regression: the carry after the final stage is `{artifacts, quiz, verdict}`.
   * `artifacts` was not a known field, so it was dropped — and a worker that
   * died between writing that checkpoint and marking the job complete resumed,
   * skipped every stage, and dereferenced `artifacts.durationSeconds` on an
   * object that no longer had it.
   */
  it('round-trips the published artifacts, so a resume after the last stage works', () => {
    const artifacts = {
      videoUrl: 'https://x/video.mp4', subtitleUrl: 'https://x/subtitles.srt',
      traceabilityUrl: 'https://x/trace.json', costUrl: 'https://x/cost.json',
      durationSeconds: 153.2,
    };

    const restored = carryFromJson(
      JSON.parse(JSON.stringify(carryToJson({ artifacts }))), preset, 400,
    ) as { artifacts?: typeof artifacts };

    expect(restored.artifacts).toEqual(artifacts);
    expect(restored.artifacts?.durationSeconds).toBe(153.2);
  });

  it('omits absent fields rather than writing nulls a stage would read as present', () => {
    expect(carryToJson({ audioSecondsTranscribed: 0 })).toEqual({ audioSecondsTranscribed: 0 });
  });
});
