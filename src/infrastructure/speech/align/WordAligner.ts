import type { WordTiming } from '@domain/media/WordTiming.js';

/**
 * Recovers word timings from audio a synthesiser produced without them.
 *
 * `SpeechSynthesisPort` promises word timings, and two of the three real
 * providers cannot supply them: OpenAI's speech endpoint returns audio only,
 * and Gemini's returns raw PCM. The port documents the answer — "a provider
 * without native timestamps is adapted by falling back to STT *inside its own
 * adapter*" — and this is that fallback, named once so the two adapters share
 * it rather than each carrying a private copy of the same transcription call.
 *
 * It is infrastructure-only on purpose. No stage knows it exists; a synthesiser
 * either reports its own boundaries or hires one of these, and either way the
 * pipeline above sees the same `SynthesisResult`.
 */
export interface WordAligner {
  /** Named for the cost report and the boot log — this work is billed. */
  readonly name: string;

  /**
   * `text` is what was *asked* to be spoken, and it changes the problem.
   *
   * Open transcription has to work out both the words and their times;
   * alignment only has to place words it already knows. Every caller here
   * synthesized the audio from text it still holds, so withholding it would be
   * throwing away the easier problem — an aligner that can use it does forced
   * alignment, and one that cannot simply ignores it.
   *
   * Returns an empty list rather than throwing when alignment fails: the audio
   * is already correct and already paid for, and the documented reveal fallback
   * inherits the previous element's time. Losing the timeline is bad; losing
   * the narration too would be worse.
   */
  align(input: {
    audioPath: string;
    text?: string;
    signal?: AbortSignal;
  }): Promise<readonly WordTiming[]>;
}
