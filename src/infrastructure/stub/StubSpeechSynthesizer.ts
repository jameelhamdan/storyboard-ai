import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SpeechSynthesisPort, SynthesisResult } from '@application/port/SpeechSynthesisPort.js';
import type { VoiceProfile } from '@domain/media/VoiceProfile.js';
import { WordTiming } from '@domain/media/WordTiming.js';
import type { FfmpegRunner } from '../encode/FfmpegRunner.js';

/**
 * Generates real silent audio of the correct length via ffmpeg, plus word timings
 * distributed across it.
 *
 * Real audio matters: the assembler, the loudness filter, the duration probe and
 * the A/V mux all run for real against it, so the only thing untested by the M2
 * slice is the voice itself. Timings are evenly spaced rather than fabricated to
 * look natural — evenly spaced is honestly wrong in a visible way, whereas
 * plausible-looking fake timings would mask sync bugs until the real adapter lands.
 */
export class StubSpeechSynthesizer implements SpeechSynthesisPort {
  private static readonly WORDS_PER_MINUTE = 150;

  constructor(
    private readonly ffmpeg: FfmpegRunner,
    private readonly voices: ReadonlyMap<string, VoiceProfile>,
  ) {}

  public async synthesize(input: {
    text: string;
    voice: VoiceProfile;
    outputPath: string;
    signal?: AbortSignal;
  }): Promise<SynthesisResult> {
    const words = input.text.split(/\s+/).filter(Boolean);
    const durationMs = Math.max(
      800,
      Math.round((words.length / StubSpeechSynthesizer.WORDS_PER_MINUTE) * 60_000),
    );

    await mkdir(dirname(input.outputPath), { recursive: true });
    await this.ffmpeg.run([
      '-f', 'lavfi',
      '-i', `anullsrc=r=48000:cl=mono`,
      '-t', (durationMs / 1000).toFixed(3),
      '-c:a', 'pcm_s16le',
      input.outputPath,
    ], input.signal);

    const perWord = durationMs / Math.max(1, words.length);
    const wordTimings = words.map((word, i) =>
      WordTiming.of(word, Math.round(i * perWord), Math.round((i + 1) * perWord)),
    );

    return {
      audioPath: input.outputPath,
      wordTimings,
      durationMs,
      characterCount: input.text.length,
    };
  }

  public async listVoices(): Promise<readonly VoiceProfile[]> {
    return [...this.voices.values()];
  }
}
