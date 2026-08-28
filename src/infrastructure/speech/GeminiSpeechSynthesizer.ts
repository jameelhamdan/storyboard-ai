import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SpeechSynthesisPort, SynthesisResult } from '@application/port/SpeechSynthesisPort.js';
import type { VoiceProfile } from '@domain/media/VoiceProfile.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import type { FfmpegRunner } from '../encode/FfmpegRunner.js';
import type { WordAligner } from './align/WordAligner.js';

export interface GeminiSpeechOptions {
  readonly apiKey: string;
  /** A TTS-capable model, e.g. `gemini-2.5-flash-preview-tts`. */
  readonly model: string;
  readonly requestTimeoutMs: number;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * Gemini returns signed 16-bit little-endian mono PCM at 24 kHz, headerless.
 * The rate is stated in the response's mime type (`audio/L16;rate=24000`); it is
 * read from there rather than assumed, because a model that switches rate would
 * otherwise produce audio played at the wrong speed with every word timing
 * silently wrong and nothing in the output looking broken.
 */
const DEFAULT_SAMPLE_RATE = 24_000;

interface SpeechResponse {
  readonly candidates?: readonly {
    readonly content?: {
      readonly parts?: readonly {
        readonly inlineData?: { readonly mimeType?: string; readonly data?: string };
      }[];
    };
  }[];
  readonly promptFeedback?: { readonly blockReason?: string };
}

/**
 * Gemini text-to-speech, on the same key as the Gemini LLM driver.
 *
 * Two things make this more than a fetch:
 *
 * 1. **It returns raw PCM, not a container.** No RIFF header, no duration, no
 *    sample rate except in the mime type. ffmpeg wraps it into the WAV the
 *    assembler expects, which is a copy of the samples rather than a re-encode,
 *    so nothing moves in time.
 * 2. **It reports no word timings**, like OpenAI's speech endpoint. The
 *    `WordAligner` recovers them — locally via whisper.cpp where it is
 *    installed, which keeps a Gemini deployment on exactly one vendor.
 *
 * The synthesiser is usable *without* an aligner, and says so loudly when it is:
 * the narration is still correct, and every reveal falls back to inheriting the
 * previous element's time. That is a worse video, not a broken one, and it is a
 * better answer than refusing to boot for a component the port treats as
 * optional.
 */
export class GeminiSpeechSynthesizer implements SpeechSynthesisPort {
  private readonly baseUrl: string;

  constructor(
    private readonly options: GeminiSpeechOptions,
    private readonly ffmpeg: FfmpegRunner,
    private readonly logger: LoggerPort,
    private readonly aligner?: WordAligner,
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  public async synthesize(input: {
    text: string;
    voice: VoiceProfile;
    outputPath: string;
    signal?: AbortSignal;
  }): Promise<SynthesisResult> {
    await mkdir(dirname(input.outputPath), { recursive: true });

    const { pcm, sampleRate } = await this.speak(input.text, input.voice, input.signal);
    await this.toWav(pcm, sampleRate, input.outputPath, input.signal);

    const durationMs = Math.round((await this.ffmpeg.durationSeconds(input.outputPath, input.signal)) * 1000);
    const wordTimings = this.aligner
      ? await this.aligner.align({
          audioPath: input.outputPath,
          text: input.text,
          ...(input.signal ? { signal: input.signal } : {}),
        })
      : [];

    if (wordTimings.length === 0) {
      // Loud: silently falling back to inherited timing looks like working sync
      // until a reveal lands a second early and nothing says why.
      this.logger.warn(
        { voice: input.voice.slot, chars: input.text.length, aligner: this.aligner?.name ?? 'none' },
        'no word timings for this scene; reveals will fall back to inherited timing',
      );
    }

    return {
      audioPath: input.outputPath,
      wordTimings,
      durationMs,
      characterCount: input.text.length,
    };
  }

  /**
   * Gemini's prebuilt voices, by slot gender.
   *
   * Like OpenAI's, these are public names rather than account-scoped ids, so a
   * slot's `.env` value is only used when it names one of them — which lets one
   * `.env` carry ElevenLabs voice ids and still work when TTS_DRIVER flips to
   * gemini.
   */
  private voiceNameFor(voice: VoiceProfile): string {
    const configured = GEMINI_VOICES.get(voice.providerVoiceId.toLowerCase());
    if (configured) return configured;
    return voice.gender === 'male' ? 'Charon' : 'Kore';
  }

  private async speak(
    text: string,
    voice: VoiceProfile,
    signal?: AbortSignal,
  ): Promise<{ pcm: Buffer; sampleRate: number }> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const response = await fetch(
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.options.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': this.options.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voiceNameFor(voice) } },
            },
          },
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable>');
      throw new Error(`Gemini speech request failed: ${response.status} ${detail.slice(0, 300)}`);
    }

    const body = (await response.json()) as SpeechResponse;
    const audio = body.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;

    if (!audio?.data) {
      // A refusal returns 200 with no audio part, which would otherwise reach
      // ffmpeg as an empty buffer and fail as "invalid data" three lines later.
      throw new Error(
        'Gemini returned no audio for this narration' +
        `${body.promptFeedback?.blockReason ? `: ${body.promptFeedback.blockReason}` : ''}.`,
      );
    }

    return { pcm: Buffer.from(audio.data, 'base64'), sampleRate: rateFrom(audio.mimeType) };
  }

  /**
   * Raw PCM in, WAV out. `-c:a copy` would not do: the input has no container to
   * copy from, so the samples are re-stated with the header ffmpeg writes. It is
   * still lossless — same bit depth, same rate, no resampling — which is what
   * keeps the word timings valid against the file the pipeline goes on to use.
   */
  private async toWav(
    pcm: Buffer,
    sampleRate: number,
    outputPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const rawPath = join(dirname(outputPath), `${Date.now()}-gemini.pcm`);
    try {
      await writeFile(rawPath, pcm);
      await this.ffmpeg.run([
        '-f', 's16le', '-ar', String(sampleRate), '-ac', '1',
        '-i', rawPath,
        '-c:a', 'pcm_s16le', outputPath,
      ], signal);
    } finally {
      await unlink(rawPath).catch(() => { /* best effort */ });
    }
  }

  /** Gemini publishes a fixed voice list, so there is nothing to query. */
  public async listVoices(): Promise<readonly VoiceProfile[]> {
    return [];
  }
}

function rateFrom(mimeType: string | undefined): number {
  const stated = /rate=(\d+)/.exec(mimeType ?? '');
  const rate = stated ? Number(stated[1]) : Number.NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_SAMPLE_RATE;
}

/**
 * The prebuilt voices, lowercase key → the capitalised name the API expects.
 *
 * A name missing from this map does not fail loudly; `voiceNameFor` treats it as
 * another vendor's id and substitutes the gender default — so an incomplete map
 * reads as "the configured voice was ignored", which is why it is kept complete
 * rather than minimal.
 */
const GEMINI_VOICES = new Map(
  [
    'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
    'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
    'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
    'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
    'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
  ].map((name) => [name.toLowerCase(), name] as const),
);
