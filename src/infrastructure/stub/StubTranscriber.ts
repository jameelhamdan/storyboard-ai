import type { TranscriptionPort, TranscriptionResult } from '@application/port/TranscriptionPort.js';
import type { Language } from '@domain/shared/Language.js';
import type { FfmpegRunner } from '../encode/FfmpegRunner.js';

/**
 * Reports the audio's real duration but no words.
 *
 * The honest failure mode: a job whose *only* source is audio will hit
 * INSUFFICIENT_CONTENT under this stub, which is correct — there genuinely is no
 * content until local Whisper is wired in at M3. It does not fabricate a
 * transcript, because a fake transcript would let the pipeline "succeed" on a
 * source it never actually read.
 */
export class StubTranscriber implements TranscriptionPort {
  constructor(private readonly ffmpeg: FfmpegRunner) {}

  public async transcribe(input: {
    audioPath: string;
    languageHint?: Language;
    signal?: AbortSignal;
  }): Promise<TranscriptionResult> {
    const audioSeconds = await this.ffmpeg.durationSeconds(input.audioPath, input.signal);

    return {
      text: '',
      detectedLanguage: input.languageHint,
      segments: [],
      audioSeconds,
    };
  }
}
