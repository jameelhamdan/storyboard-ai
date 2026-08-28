import type { ContentExtractorPort, ExtractionInput } from '@application/port/ContentExtractorPort.js';
import { SourceDocument } from '@domain/content/SourceDocument.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';
import type { FfmpegRunner } from '../encode/FfmpegRunner.js';

const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/ogg']);

/**
 * Audio has no text to extract, so this stage only validates and hands off: it
 * emits a placeholder chunk flagged `awaiting-transcription`, which is the signal
 * TranscribeAudioStage looks for. Keeping STT out of ingestion means the duration
 * check happens before any transcription cost is incurred.
 */
export class AudioFileExtractor implements ContentExtractorPort {
  public readonly name = 'audio';

  constructor(
    private readonly ffmpeg: FfmpegRunner,
    private readonly maxDurationSeconds: number,
  ) {}

  public supports(mimeType: string): boolean {
    return AUDIO_MIMES.has(mimeType);
  }

  public async extract(input: ExtractionInput): Promise<SourceDocument> {
    if (!input.localPath) throw new UnsupportedFormatError('Audio source has no local file.');

    const seconds = await this.ffmpeg.durationSeconds(input.localPath);
    if (seconds > this.maxDurationSeconds) {
      throw UnsupportedFormatError.overLimit(
        `audio duration in seconds for '${input.sourceId}'`,
        Math.round(seconds),
        this.maxDurationSeconds,
      );
    }

    return SourceDocument.of({
      id: input.sourceId,
      origin: input.origin,
      kind: 'transcript',
      chunks: [ContentChunk.of({
        id: `${input.sourceId}:pending`,
        text: '[pending transcription]',
        refs: [SourceRef.timestamp(input.sourceId, 0)],
        kind: 'transcript',
        mediaRefs: [input.localPath],
      })],
      extractionWarnings: ['awaiting-transcription'],
    });
  }
}
