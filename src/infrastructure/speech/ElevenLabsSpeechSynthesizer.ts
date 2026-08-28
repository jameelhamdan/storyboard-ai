import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SpeechSynthesisPort, SynthesisResult } from '@application/port/SpeechSynthesisPort.js';
import type { VoiceProfile } from '@domain/media/VoiceProfile.js';
import { WordTiming } from '@domain/media/WordTiming.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';

export interface ElevenLabsOptions {
  readonly apiKey: string;
  readonly modelId: string;
  readonly outputFormat: string;
  readonly requestTimeoutMs: number;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';

/** The `with-timestamps` response. Only the fields we rely on. */
interface TimestampedResponse {
  readonly audio_base64: string;
  readonly alignment: {
    readonly characters: readonly string[];
    readonly character_start_times_seconds: readonly number[];
    readonly character_end_times_seconds: readonly number[];
  } | null;
}

/**
 * ElevenLabs TTS via the `with-timestamps` endpoint.
 *
 * That endpoint rather than the plain one because plain returns audio only, and
 * the pipeline's whole timeline is word-anchored — every `data-on` phrase
 * resolves against these timings. They come from the synthesiser's own
 * alignment rather than from force-aligning the audio afterwards, which is what
 * keeps FR-8's 100ms subtitle tolerance a property of the data.
 *
 * ElevenLabs reports *per-character* timings, so words are reassembled here.
 * That is strictly more information than a word-boundary event carries: a word's
 * start is its first character's start and its end is its last character's end,
 * with no interpolation anywhere.
 *
 * Plain `fetch` rather than the vendor SDK: one endpoint, one auth header, and
 * no dependency to keep current or audit.
 */
export class ElevenLabsSpeechSynthesizer implements SpeechSynthesisPort {
  private readonly baseUrl: string;

  constructor(
    private readonly options: ElevenLabsOptions,
    private readonly voices: ReadonlyMap<string, VoiceProfile>,
    private readonly logger: LoggerPort,
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

    const url =
      `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(input.voice.providerVoiceId)}` +
      `/with-timestamps?output_format=${encodeURIComponent(this.options.outputFormat)}`;

    const body = await this.post<TimestampedResponse>(url, {
      text: input.text,
      model_id: this.options.modelId,
    }, input.signal);

    const audio = Buffer.from(body.audio_base64, 'base64');
    await writeFile(input.outputPath, audio);

    const wordTimings = body.alignment ? wordsFromAlignment(body.alignment) : [];
    const durationMs = alignmentDurationMs(body.alignment) ?? estimateDurationMs(input.text);

    if (wordTimings.length === 0) {
      // Loud: silently falling back to even spacing looks like working sync
      // while every reveal and every cue boundary drifts.
      this.logger.warn(
        { voice: input.voice.slot, characters: input.text.length },
        'ElevenLabs returned no alignment; reveal timing fell back to even spacing',
      );
    }

    return {
      audioPath: input.outputPath,
      wordTimings: wordTimings.length > 0 ? wordTimings : evenlySpaced(input.text, durationMs),
      durationMs,
      characterCount: input.text.length,
    };
  }

  /**
   * Live from the account rather than from config, because the configured slots
   * are only meaningful if the ids behind them still exist — a voice removed
   * upstream should surface here, not three stages into a job.
   */
  public async listVoices(): Promise<readonly VoiceProfile[]> {
    try {
      const body = await this.get<{ voices?: readonly { voice_id: string; name?: string }[] }>(
        `${this.baseUrl}/v1/voices`,
      );
      const available = new Set((body.voices ?? []).map((v) => v.voice_id));
      const missing = [...this.voices.values()].filter((v) => !available.has(v.providerVoiceId));
      if (missing.length > 0) {
        this.logger.warn(
          { slots: missing.map((v) => v.slot) },
          'Configured voice slots reference ids the ElevenLabs account cannot see',
        );
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not list ElevenLabs voices; returning configured slots');
    }
    return [...this.voices.values()];
  }

  private async post<T>(url: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>(url, {
      method: 'POST',
      headers: { 'xi-api-key': this.options.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }, signal);
  }

  private async get<T>(url: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>(url, {
      method: 'GET',
      headers: { 'xi-api-key': this.options.apiKey },
    }, signal);
  }

  /**
   * The caller's signal and our own timeout are combined, so a cancelled job
   * tears the socket down rather than waiting out the timeout.
   */
  private async request<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: combined });
    } catch (error) {
      if (signal?.aborted) throw new Error('Cancelled during speech synthesis.');
      if (timeout.aborted) {
        throw new Error(`ElevenLabs did not respond within ${this.options.requestTimeoutMs}ms.`);
      }
      throw error;
    }

    if (!response.ok) {
      throw new Error(`ElevenLabs TTS failed: ${response.status} ${await safeBody(response)}`);
    }
    return (await response.json()) as T;
  }
}

/**
 * Character timings collapsed into word timings.
 *
 * Whitespace separates words and carries no timing of its own; a word spans
 * from its first character's start to its last character's end. Characters
 * whose timings are missing are skipped rather than defaulted, so a truncated
 * alignment shortens the timeline instead of silently placing words at zero.
 */
export function wordsFromAlignment(alignment: {
  readonly characters: readonly string[];
  readonly character_start_times_seconds: readonly number[];
  readonly character_end_times_seconds: readonly number[];
}): WordTiming[] {
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;

  const words: WordTiming[] = [];
  let text = '';
  let startMs: number | undefined;
  let endMs = 0;

  const flush = (): void => {
    if (text.length > 0 && startMs !== undefined) {
      words.push(WordTiming.of(text, Math.round(startMs), Math.round(endMs)));
    }
    text = '';
    startMs = undefined;
  };

  for (let i = 0; i < characters.length; i += 1) {
    const char = characters[i] ?? '';
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    const start = starts[i];
    const end = ends[i];
    if (start === undefined || end === undefined) continue;

    if (startMs === undefined) startMs = start * 1000;
    endMs = end * 1000;
    text += char;
  }
  flush();

  return words;
}

/** The last character's end time is the audio's own duration — no probe needed. */
export function alignmentDurationMs(
  alignment: { readonly character_end_times_seconds: readonly number[] } | null,
): number | undefined {
  const ends = alignment?.character_end_times_seconds;
  if (!ends || ends.length === 0) return undefined;
  const last = ends[ends.length - 1];
  return last === undefined ? undefined : Math.round(last * 1000);
}

/** The documented fallback when a provider yields no timings. */
function evenlySpaced(text: string, durationMs: number): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const perWord = durationMs / words.length;
  return words.map((word, i) =>
    WordTiming.of(word, Math.round(i * perWord), Math.round((i + 1) * perWord)),
  );
}

function estimateDurationMs(text: string): number {
  return Math.max(800, Math.round((text.split(/\s+/).filter(Boolean).length / 150) * 60_000));
}

async function safeBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '<unreadable>';
  }
}
