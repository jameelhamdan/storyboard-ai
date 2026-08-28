import type { QualityPreset } from '@domain/media/QualityPreset.js';
import type { SubtitleCue } from '@domain/media/SubtitleCue.js';

export interface EncodeResult {
  readonly path: string;
  readonly durationSeconds: number;
  readonly sizeBytes: number;
}

export interface VideoEncoderPort {
  /** ffmpeg concat of rendered segments + audio mux, encoded per the preset. */
  assemble(input: {
    segmentPaths: readonly string[];
    audioPath: string;
    outputPath: string;
    preset: QualityPreset;
    /**
     * Muxed in as a selectable track when present. The sidecar .srt is still
     * published — this is so a viewer who only has the MP4 still gets subtitles.
     */
    subtitles?: { path: string; languageCode: string };
    signal?: AbortSignal;
  }): Promise<EncodeResult>;

  /** EBU R128 loudness normalisation, silence trim, inter-scene pauses. */
  concatAudio(input: {
    parts: readonly { path: string; gapAfterMs: number }[];
    outputPath: string;
    targetLufs: number;
    truePeakDb: number;
    signal?: AbortSignal;
  }): Promise<{ path: string; durationMs: number }>;

  writeSubtitles(cues: readonly SubtitleCue[], outputPath: string): Promise<string>;

  probeDurationSeconds(path: string): Promise<number>;
}
