import { readFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import { WordTiming } from '@domain/media/WordTiming.js';
import type { FfmpegRunner } from '../../encode/FfmpegRunner.js';
import { runWhisperCli } from '../whisperCli.js';
import { parseWhisperJson } from '../WhisperCliTranscriber.js';
import type { WordAligner } from './WordAligner.js';

export interface WhisperAlignerOptions {
  readonly binaryPath: string;
  readonly modelPath: string;
  readonly threads: number;
  readonly timeoutMs: number;
}

/**
 * Word timings from the local whisper.cpp build, for free.
 *
 * `-ml 1` caps each segment at one token, which turns the same JSON the
 * transcriber already parses into word-level timing. That is the whole
 * difference between this and `WhisperCliTranscriber`: same binary, same model,
 * same parser, a different granularity for a different consumer.
 *
 * Preferred over the hosted aligner whenever whisper.cpp is installed — it costs
 * nothing, and narration audio never leaves the machine, which keeps a
 * Gemini-or-OpenAI TTS deployment from quietly adding a second vendor to the
 * data path just to learn where the words are.
 */
export class WhisperCliWordAligner implements WordAligner {
  public readonly name = 'whisper';

  constructor(
    private readonly options: WhisperAlignerOptions,
    private readonly ffmpeg: FfmpegRunner,
    private readonly logger: LoggerPort,
  ) {}

  public async align(input: {
    audioPath: string;
    text?: string;
    signal?: AbortSignal;
  }): Promise<readonly WordTiming[]> {
    // `text` is unused: whisper.cpp has no forced-alignment mode, so this is
    // open transcription of speech we happen to know the words of.
    const { audioPath, signal } = input;
    // whisper.cpp reads 16 kHz mono WAV and nothing else.
    const wavPath = join(dirname(audioPath), `${Date.now()}-align.wav`);
    const outputPrefix = `${wavPath}.out`;

    try {
      await this.ffmpeg.run([
        '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath,
      ], signal);

      await runWhisperCli(this.options.binaryPath, [
        '-m', this.options.modelPath,
        '-f', wavPath,
        '-t', String(this.options.threads),
        '-ml', '1',                  // one token per segment — word-level timing
        '-oj', '-of', outputPrefix,
      ], this.options.timeoutMs, signal);

      const { segments } = parseWhisperJson(await readFile(`${outputPrefix}.json`, 'utf8'));

      return segments
        .filter((segment) => segment.endSeconds > segment.startSeconds)
        .map((segment) => WordTiming.of(
          segment.text,
          Math.round(segment.startSeconds * 1000),
          Math.round(segment.endSeconds * 1000),
        ));
    } catch (error) {
      // Recoverable, for the reason stated on WordAligner: the audio is correct
      // and already paid for.
      this.logger.warn({ err: error }, 'word alignment failed; continuing without timings');
      return [];
    } finally {
      await Promise.all([
        unlink(wavPath).catch(() => { /* best effort */ }),
        unlink(`${outputPrefix}.json`).catch(() => { /* best effort */ }),
      ]);
    }
  }
}
