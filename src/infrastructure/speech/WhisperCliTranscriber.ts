import { readFile, unlink, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { TranscriptionPort, TranscriptionResult } from '@application/port/TranscriptionPort.js';
import type { Language } from '@domain/shared/Language.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import type { FfmpegRunner } from '../encode/FfmpegRunner.js';
import { runWhisperCli } from './whisperCli.js';

export interface WhisperOptions {
  /** `whisper-cli` from whisper.cpp, or anything with the same flags. */
  readonly binaryPath: string;
  /** Path to a ggml model file, e.g. ggml-large-v3-turbo.bin. */
  readonly modelPath: string;
  readonly timeoutMs: number;
  /** Whisper is CPU-bound; leave headroom for the renderer on the same box. */
  readonly threads: number;
}

interface WhisperJson {
  transcription?: {
    text?: string;
    offsets?: { from: number; to: number };
  }[];
}

/**
 * Local Whisper via whisper.cpp's CLI.
 *
 * This is the plan's preferred path (§5): student audio never leaves the
 * machine, which is both the cleanest GDPR position and free. The hosted
 * It is the only transcriber: audio never leaves the machine.
 *
 * Shelling out to the binary rather than binding to it in-process is deliberate.
 * The Node bindings for whisper.cpp need a native compile at install time, which
 * turns a broken toolchain into a failed `npm install` for everyone — including
 * people who will never transcribe anything. A subprocess costs a few hundred
 * milliseconds per file and keeps the dependency optional.
 *
 * Set `STT_DRIVER=whisper` and point `WHISPER_BINARY` / `WHISPER_MODEL_PATH` at
 * an installed build.
 */
export class WhisperCliTranscriber implements TranscriptionPort {
  constructor(
    private readonly options: WhisperOptions,
    private readonly ffmpeg: FfmpegRunner,
    private readonly logger: LoggerPort,
  ) {}

  /** Checked at boot so a missing binary is a startup error, not a job failure. */
  public async verifyAvailable(): Promise<void> {
    for (const [what, path] of [['binary', this.options.binaryPath], ['model', this.options.modelPath]] as const) {
      try {
        await access(path);
      } catch {
        throw new Error(
          `Whisper ${what} not found at '${path}'. ` +
          'Install whisper.cpp and set WHISPER_BINARY and WHISPER_MODEL_PATH, or use STT_DRIVER=stub.',
        );
      }
    }
  }

  public async transcribe(input: {
    audioPath: string;
    languageHint?: Language;
    signal?: AbortSignal;
  }): Promise<TranscriptionResult> {
    const audioSeconds = await this.ffmpeg.durationSeconds(input.audioPath, input.signal);

    // whisper.cpp reads 16 kHz mono WAV and nothing else.
    const wavPath = join(dirname(input.audioPath), `${Date.now()}-whisper.wav`);
    await this.ffmpeg.run([
      '-i', input.audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath,
    ], input.signal);

    const outputPrefix = `${wavPath}.out`;

    try {
      await this.run([
        '-m', this.options.modelPath,
        '-f', wavPath,
        '-t', String(this.options.threads),
        '-oj', '-of', outputPrefix,     // JSON output, to <prefix>.json
        ...(input.languageHint ? ['-l', input.languageHint.code] : ['-l', 'auto']),
      ], input.signal);

      const raw = await readFile(`${outputPrefix}.json`, 'utf8');
      const { segments, text } = parseWhisperJson(raw);

      if (segments.length === 0) {
        this.logger.warn({ audioSeconds }, 'whisper produced no speech segments');
      }

      return {
        text,
        detectedLanguage: input.languageHint,
        segments,
        audioSeconds,
      };
    } finally {
      await Promise.all([
        unlink(wavPath).catch(() => { /* best effort */ }),
        unlink(`${outputPrefix}.json`).catch(() => { /* best effort */ }),
      ]);
    }
  }

  private run(args: readonly string[], signal?: AbortSignal): Promise<void> {
    return runWhisperCli(this.options.binaryPath, args, this.options.timeoutMs, signal);
  }
}

/**
 * whisper.cpp reports offsets in milliseconds. With `-ml 1` each segment is a
 * single token, which gives word-level timing directly; without it the tokens
 * array carries the same information at a coarser grain.
 */
export function parseWhisperJson(raw: string): {
  segments: { text: string; startSeconds: number; endSeconds: number }[];
  text: string;
} {
  let parsed: WhisperJson;
  try {
    parsed = JSON.parse(raw) as WhisperJson;
  } catch {
    return { segments: [], text: '' };
  }

  const segments: { text: string; startSeconds: number; endSeconds: number }[] = [];

  for (const entry of parsed.transcription ?? []) {
    const text = (entry.text ?? '').trim();
    if (!text || !entry.offsets) continue;

    segments.push({
      text,
      startSeconds: entry.offsets.from / 1000,
      endSeconds: entry.offsets.to / 1000,
    });
  }

  return { segments, text: segments.map((s) => s.text).join(' ') };
}
