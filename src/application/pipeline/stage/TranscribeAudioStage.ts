import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import type { TranscriptionPort } from '../../port/TranscriptionPort.js';
import { SourceDocument } from '@domain/content/SourceDocument.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import type { IngestedSources, TranscribedSources } from './types.js';

/**
 * Audio sources arrive from ingest with their file path but no text. Local Whisper
 * turns them into timestamped chunks — student audio never leaves the machine,
 * which is both the cleanest GDPR position and free.
 */
export class TranscribeAudioStage implements PipelineStage<IngestedSources, TranscribedSources> {
  public readonly name: StageName = 'transcribe';

  constructor(private readonly transcriber: TranscriptionPort) {}

  public async execute(input: IngestedSources, ctx: PipelineContext): Promise<TranscribedSources> {
    const pending = input.documents.filter((d) => d.extractionWarnings.includes('awaiting-transcription'));
    if (pending.length === 0) {
      return { documents: input.documents, audioSecondsTranscribed: 0 };
    }

    const byId = new Map(input.documents.map((d) => [d.id, d]));
    let audioSeconds = 0;
    let done = 0;

    for (const document of pending) {
      ctx.throwIfCancelled();

      const audioPath = document.chunks[0]?.mediaRefs[0];
      if (!audioPath) {
        ctx.logger.warn({ sourceId: document.id }, 'marked for transcription but carries no audio reference');
        continue;
      }

      const result = await this.transcriber.transcribe({
        audioPath,
        ...(document.detectedLanguage ? { languageHint: document.detectedLanguage } : {}),
        signal: ctx.signal,
      });

      audioSeconds += result.audioSeconds;
      ctx.costMeter.recordStt(this.name, result.audioSeconds);

      // One chunk per segment: a claim traced back to a lecture recording resolves
      // to the second it was said, not to "somewhere in this 40-minute file".
      const chunks = result.segments.map((segment, i) => ContentChunk.of({
        id: `${document.id}:seg${i}`,
        text: segment.text,
        refs: [SourceRef.timestamp(document.id, segment.startSeconds)],
        kind: 'transcript',
        ...(result.detectedLanguage ? { detectedLanguage: result.detectedLanguage } : {}),
        order: i,
      }));

      byId.set(document.id, SourceDocument.of({
        id: document.id,
        origin: document.origin,
        kind: 'transcript',
        chunks,
        ...(result.detectedLanguage ? { detectedLanguage: result.detectedLanguage } : {}),
        extractionWarnings: document.extractionWarnings.filter((w) => w !== 'awaiting-transcription'),
      }));

      done += 1;
      ctx.reportProgress(this.name, done / pending.length);
    }

    return { documents: [...byId.values()], audioSecondsTranscribed: audioSeconds };
  }

}
