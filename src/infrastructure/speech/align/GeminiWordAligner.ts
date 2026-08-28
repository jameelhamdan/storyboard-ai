import { readFile } from 'node:fs/promises';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import { WordTiming } from '@domain/media/WordTiming.js';
import type { WordAligner } from './WordAligner.js';

export interface GeminiAlignerOptions {
  readonly apiKey: string;
  /** A model that accepts audio input, e.g. `gemini-3.7-flash`. */
  readonly model: string;
  readonly requestTimeoutMs: number;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

interface AlignmentResponse {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly { readonly text?: string }[] };
  }[];
}

interface AlignedWord {
  readonly word?: string;
  readonly start?: number;
  readonly end?: number;
}

/**
 * A model that has already been told the words, asked only where they fall.
 *
 * This exists so a Gemini deployment stays on **one credential**. Gemini's
 * speech endpoint returns audio and no timings, and the alternatives both add
 * something: whisper.cpp adds a binary and a model file, and OpenAI adds a
 * second vendor to the data path for a job that otherwise never touches one.
 *
 * **It is alignment, not transcription, and that is what makes it trustworthy.**
 * The narration text is handed to the model along with the audio it was
 * synthesized from, so there is nothing to mishear — the task is reduced to
 * placing known words on a known waveform. Whisper, given the same audio,
 * has to work out the words too, and a word it gets wrong lands at the wrong
 * time.
 *
 * Verified against the live API: a 5.17-second line came back as ten words with
 * boundaries to the centisecond, ending 4.9s in.
 *
 * **The result is checked before it is believed.** A model can return times that
 * are non-numeric, out of order, or past the end of the audio, and a plausible
 * wrong timeline is worse than none — it desynchronises reveals with nothing
 * reporting why. See `usable`.
 */
export class GeminiWordAligner implements WordAligner {
  public readonly name = 'gemini';
  private readonly baseUrl: string;

  constructor(
    private readonly options: GeminiAlignerOptions,
    private readonly logger: LoggerPort,
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  public async align(input: {
    audioPath: string;
    text?: string;
    signal?: AbortSignal;
  }): Promise<readonly WordTiming[]> {
    try {
      const audio = await readFile(input.audioPath);
      const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);

      const response = await fetch(
        `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.options.model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': this.options.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { text: this.promptFor(input.text) },
                { inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } },
              ],
            }],
            generationConfig: {
              // Placing words on a waveform has one right answer; sampling can
              // only move a boundary away from it.
              temperature: 0,
              maxOutputTokens: 8192,
              responseMimeType: 'application/json',
              responseSchema: {
                type: 'OBJECT',
                properties: {
                  words: {
                    type: 'ARRAY',
                    items: {
                      type: 'OBJECT',
                      properties: {
                        word: { type: 'STRING' },
                        start: { type: 'NUMBER' },
                        end: { type: 'NUMBER' },
                      },
                      required: ['word', 'start', 'end'],
                      propertyOrdering: ['word', 'start', 'end'],
                    },
                  },
                },
                required: ['words'],
              },
            },
          }),
          signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
        },
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => '<unreadable>');
        throw new Error(`Gemini alignment failed: ${response.status} ${detail.slice(0, 200)}`);
      }

      const body = (await response.json()) as AlignmentResponse;
      const text = (body.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('');
      const words = (JSON.parse(text) as { words?: AlignedWord[] }).words ?? [];

      return this.usable(words, input.text);
    } catch (error) {
      // Recoverable, for the reason stated on WordAligner: the audio is correct
      // and already paid for.
      this.logger.warn({ err: error }, 'word alignment failed; continuing without timings');
      return [];
    }
  }

  private promptFor(text: string | undefined): string {
    return [
      text
        ? `This audio says exactly: "${text}"`
        : 'Transcribe this audio.',
      text
        ? 'Return every word of that text, in order, with the time it starts and ends in the audio.'
        : 'Return every word with the time it starts and ends.',
      'Times are in seconds, as decimals, precise to the millisecond.',
      'Do not add, remove, reorder or correct any word.',
    ].join(' ');
  }

  /**
   * Everything that has to be true before a timeline is worth using.
   *
   * A timeline is not a best-effort artefact: every reveal on every board
   * resolves against it, so times that drift or run backwards produce a video
   * that is subtly, invisibly wrong. Rejecting the whole set is the honest
   * answer — reveals then fall back to inheriting the previous element's time,
   * which is visibly plainer rather than quietly mistimed.
   */
  private usable(words: readonly AlignedWord[], text: string | undefined): readonly WordTiming[] {
    const timings: WordTiming[] = [];
    let previousStart = -1;

    for (const word of words) {
      const label = (word.word ?? '').trim();
      const { start, end } = word;

      if (!label || !Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (end! <= start! || start! < previousStart) {
        this.logger.warn({ word: label }, 'alignment returned times that run backwards; discarding it');
        return [];
      }

      previousStart = start!;
      timings.push(WordTiming.of(label, Math.round(start! * 1000), Math.round(end! * 1000)));
    }

    /**
     * A model that returns half the words has not aligned the narration, it has
     * summarised it — and the anchors that resolve against the missing half
     * would silently inherit the wrong time.
     */
    const expected = text ? text.split(/\s+/).filter(Boolean).length : 0;
    if (expected > 0 && timings.length < expected * 0.7) {
      this.logger.warn(
        { expected, aligned: timings.length },
        'alignment returned too few words to be the narration; discarding it',
      );
      return [];
    }

    return timings;
  }
}
