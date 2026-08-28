import { describe, it, expect } from 'vitest';
import { parseWhisperJson } from '@infrastructure/speech/WhisperCliTranscriber.js';
import { TranscribeAudioStage } from '@application/pipeline/stage/TranscribeAudioStage.js';
import { SourceDocument } from '@domain/content/SourceDocument.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { Language } from '@domain/shared/Language.js';
import type { PipelineContext } from '@application/pipeline/PipelineContext.js';

/**
 * Both providers report timings in their own units and shapes. Getting the
 * conversion wrong does not fail loudly — it produces a transcript whose
 * timings are silently off by a factor, which then propagates into every quiz
 * timestamp and every subtitle cue built from that audio.
 */
describe('whisper.cpp JSON parsing', () => {
  // whisper.cpp reports offsets already in milliseconds.
  const whisperOut = JSON.stringify({
    transcription: [
      {
        text: ' Photosynthesis converts light',
        offsets: { from: 0, to: 2000 },
        tokens: [
          { text: ' Photosynthesis', offsets: { from: 0, to: 800 } },
          { text: ' converts', offsets: { from: 800, to: 1400 } },
          { text: ' light', offsets: { from: 1400, to: 2000 } },
        ],
      },
      {
        text: ' into chemical energy.',
        offsets: { from: 2000, to: 3600 },
        tokens: [
          { text: ' into', offsets: { from: 2000, to: 2400 } },
          { text: ' chemical', offsets: { from: 2400, to: 3000 } },
          { text: ' energy', offsets: { from: 3000, to: 3400 } },
          { text: '.', offsets: { from: 3400, to: 3600 } },
        ],
      },
    ],
  });

  it('treats offsets as milliseconds, not ticks', () => {
    const { segments } = parseWhisperJson(whisperOut);
    expect(segments[0]!.startSeconds).toBe(0);
    expect(segments[0]!.endSeconds).toBe(2);
  });

  it('trims whisper leading spaces from segment text', () => {
    expect(parseWhisperJson(whisperOut).segments[0]!.text).toBe('Photosynthesis converts light');
  });

  it('builds segments with second-based bounds', () => {
    const { segments } = parseWhisperJson(whisperOut);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ startSeconds: 0, endSeconds: 2 });
    expect(segments[1]!.startSeconds).toBe(2);
  });

  it('joins segment text into the full transcript', () => {
    expect(parseWhisperJson(whisperOut).text)
      .toBe('Photosynthesis converts light into chemical energy.');
  });

  it('keeps segments in order', () => {
    const { segments } = parseWhisperJson(whisperOut);
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]!.startSeconds).toBeGreaterThanOrEqual(segments[i - 1]!.startSeconds);
    }
  });

  it('returns nothing rather than throwing on malformed input', () => {
    expect(parseWhisperJson('not json')).toEqual({ segments: [], text: '' });
    expect(parseWhisperJson('{}').segments).toEqual([]);
  });

  it('skips a segment with no offsets rather than timing it at zero', () => {
    const { segments } = parseWhisperJson(JSON.stringify({
      transcription: [{ text: 'no timing here' }, { text: 'timed', offsets: { from: 500, to: 900 } }],
    }));
    expect(segments.map((s) => s.text)).toEqual(['timed']);
  });
});

describe('TranscribeAudioStage', () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, child: () => logger };

  const ctx = () => ({
    logger,
    costMeter: { recordStt: noop },
    signal: new AbortController().signal,
    throwIfCancelled: noop,
    reportProgress: noop,
  }) as unknown as PipelineContext;

  const pendingAudioDoc = () => SourceDocument.of({
    id: 'lecture',
    origin: { type: 'file', filename: 'lecture.mp3', mimeType: 'audio/mpeg', bytes: 1 },
    kind: 'transcript',
    chunks: [ContentChunk.of({
      id: 'lecture:pending',
      text: '[pending transcription]',
      refs: [SourceRef.timestamp('lecture', 0)],
      kind: 'transcript',
      mediaRefs: ['/tmp/lecture.mp3'],
    })],
    extractionWarnings: ['awaiting-transcription'],
  });

  const fakeTranscriber = (segments: { text: string; startSeconds: number; endSeconds: number }[]) => ({
    transcribe: async () => ({
      text: segments.map((s) => s.text).join(' '),
      detectedLanguage: Language.of('en'),
      segments,
      audioSeconds: 120,
    }),
  });

  it('replaces the placeholder chunk with timestamped segments', async () => {
    const stage = new TranscribeAudioStage(fakeTranscriber([
      { text: 'First point about photosynthesis.', startSeconds: 0, endSeconds: 8 },
      { text: 'Second point about the Calvin cycle.', startSeconds: 8, endSeconds: 15 },
    ]));

    const result = await stage.execute({ documents: [pendingAudioDoc()] }, ctx());
    const doc = result.documents[0]!;

    expect(doc.chunks).toHaveLength(2);
    expect(doc.chunks[0]!.text).toBe('First point about photosynthesis.');
    expect(doc.extractionWarnings).not.toContain('awaiting-transcription');
  });

  /** FR-13: a claim from a recording must cite the second it was said. */
  it('cites each chunk at the second its segment begins', async () => {
    const stage = new TranscribeAudioStage(fakeTranscriber([
      { text: 'Alpha.', startSeconds: 0, endSeconds: 5 },
      { text: 'Beta.', startSeconds: 42, endSeconds: 50 },
    ]));

    const result = await stage.execute({ documents: [pendingAudioDoc()] }, ctx());
    const locators = result.documents[0]!.chunks.map((c) => c.refs[0]!.locator);

    expect(locators).toEqual([
      { kind: 'timestamp', seconds: 0 },
      { kind: 'timestamp', seconds: 42 },
    ]);
  });

  it('reports the audio seconds it consumed, for the cost meter', async () => {
    const stage = new TranscribeAudioStage(fakeTranscriber([{ text: 'x', startSeconds: 0, endSeconds: 1 }]));
    const result = await stage.execute({ documents: [pendingAudioDoc()] }, ctx());
    expect(result.audioSecondsTranscribed).toBe(120);
  });

  it('leaves documents that need no transcription untouched', async () => {
    const pdf = SourceDocument.of({
      id: 'notes',
      origin: { type: 'file', filename: 'notes.pdf', mimeType: 'application/pdf', bytes: 1 },
      kind: 'typed_document',
      chunks: [ContentChunk.of({
        id: 'notes:1', text: 'Already extracted text.',
        refs: [SourceRef.page('notes', 1)], kind: 'typed_document',
      })],
    });

    const stage = new TranscribeAudioStage(fakeTranscriber([]));
    const result = await stage.execute({ documents: [pdf] }, ctx());

    expect(result.documents[0]!.chunks[0]!.text).toBe('Already extracted text.');
    expect(result.audioSecondsTranscribed).toBe(0);
  });

  /**
   * A transcriber that hears nothing must not fabricate content. The job then
   * fails at consolidation with INSUFFICIENT_CONTENT, which is the truthful
   * outcome for audio nothing could read.
   */
  it('produces no chunks when the transcriber returns no speech', async () => {
    const stage = new TranscribeAudioStage(fakeTranscriber([]));
    const result = await stage.execute({ documents: [pendingAudioDoc()] }, ctx());
    expect(result.documents[0]!.chunks).toHaveLength(0);
  });
});
