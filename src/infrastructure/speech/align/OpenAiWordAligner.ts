import { readFile } from 'node:fs/promises';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import { WordTiming } from '@domain/media/WordTiming.js';
import type { WordAligner } from './WordAligner.js';

export interface OpenAiAlignerOptions {
  readonly apiKey: string;
  /** A transcription model with word-level granularity, e.g. `whisper-1`. */
  readonly model: string;
  readonly requestTimeoutMs: number;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com';

interface VerboseTranscription {
  readonly words?: readonly { readonly word: string; readonly start: number; readonly end: number }[];
}

/**
 * Word timings from OpenAI's transcription endpoint.
 *
 * The timings are *recovered, not authoritative*: Whisper aligns against audio
 * it did not produce, so a word it mishears lands at the wrong time. In practice
 * it is aligning speech synthesized from text we already have, which is the easy
 * case — but it is strictly weaker than a synthesiser reporting its own
 * boundaries, and billed per audio-minute on top of synthesis.
 */
export class OpenAiWordAligner implements WordAligner {
  public readonly name = 'openai';
  private readonly baseUrl: string;

  constructor(
    private readonly options: OpenAiAlignerOptions,
    private readonly logger: LoggerPort,
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  public async align(input: {
    audioPath: string;
    text?: string;
    signal?: AbortSignal;
  }): Promise<readonly WordTiming[]> {
    const { audioPath, signal } = input;
    try {
      const form = new FormData();
      form.append('file', new Blob([await readFile(audioPath)]), 'narration.wav');
      form.append('model', this.options.model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      // Whisper's `prompt` biases decoding toward text it is told to expect,
      // which is exactly what we have. It is a hint, not a constraint — this is
      // still transcription — but a mishearing is what puts a word at the wrong
      // time, and this is the cheapest thing that reduces them.
      if (input.text) form.append('prompt', input.text.slice(0, 900));

      const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
      const response = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '<unreadable>');
        throw new Error(`OpenAI transcription failed: ${response.status} ${detail.slice(0, 300)}`);
      }

      const body = (await response.json()) as VerboseTranscription;
      return (body.words ?? [])
        .filter((w) => w.word.trim() && Number.isFinite(w.start) && w.end > w.start)
        .map((w) => WordTiming.of(w.word.trim(), Math.round(w.start * 1000), Math.round(w.end * 1000)));
    } catch (error) {
      this.logger.warn({ err: error }, 'word alignment failed; continuing without timings');
      return [];
    }
  }
}
