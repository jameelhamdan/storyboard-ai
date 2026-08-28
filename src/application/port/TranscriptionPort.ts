import type { Language } from '@domain/shared/Language.js';

export interface TranscriptionResult {
  readonly text: string;
  readonly detectedLanguage: Language | undefined;
  /**
   * Timestamped segments. This is the granularity a citation resolves to, so a
   * claim taken from a lecture recording points at the second it was said
   * rather than at the file.
   *
   * Deliberately not word-level: nothing downstream consumes word timings from
   * *source* audio. The narration's word timings — which drive reveals and
   * subtitle boundaries — come from the synthesiser at stage 7, not from here.
   */
  readonly segments: readonly { text: string; startSeconds: number; endSeconds: number }[];
  readonly audioSeconds: number;
}

export interface TranscriptionPort {
  transcribe(input: {
    audioPath: string;
    languageHint?: Language;
    signal?: AbortSignal;
  }): Promise<TranscriptionResult>;
}
