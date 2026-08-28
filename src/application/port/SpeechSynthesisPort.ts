import type { VoiceProfile } from '@domain/media/VoiceProfile.js';
import type { WordTiming } from '@domain/media/WordTiming.js';

export interface SynthesisResult {
  readonly audioPath: string;
  /** From the synthesiser itself — exact, not force-aligned. */
  readonly wordTimings: readonly WordTiming[];
  readonly durationMs: number;
  readonly characterCount: number;
}

/**
 * Synthesis and word timings together, because that is what the pipeline needs —
 * not because a vendor happens to return both. A provider without native
 * timestamps is adapted by falling back to STT *inside its own adapter*, so the
 * port shape never leaks the difference.
 */
export interface SpeechSynthesisPort {
  synthesize(input: {
    text: string;
    voice: VoiceProfile;
    outputPath: string;
    signal?: AbortSignal;
  }): Promise<SynthesisResult>;

  listVoices(): Promise<readonly VoiceProfile[]>;
}
