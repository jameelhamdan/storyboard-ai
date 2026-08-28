import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SpeechSynthesisPort, SynthesisResult } from '@application/port/SpeechSynthesisPort.js';
import type { VoiceProfile } from '@domain/media/VoiceProfile.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import type { FfmpegRunner } from '../encode/FfmpegRunner.js';
import { OpenAiWordAligner } from './align/OpenAiWordAligner.js';

export interface OpenAiSpeechOptions {
  readonly apiKey: string;
  /** Synthesis model, e.g. `gpt-4o-mini-tts` or `tts-1`. */
  readonly model: string;
  /**
   * Transcription model used to recover word timings, e.g. `whisper-1`.
   * See the class comment: OpenAI's speech endpoint returns audio only.
   */
  readonly alignModel: string;
  readonly requestTimeoutMs: number;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com';

/**
 * OpenAI text-to-speech, on the same key as the LLM.
 *
 * **The alignment problem.** The pipeline's whole timeline is word-anchored —
 * every `data-on` phrase resolves against word timings, and FR-8's 100ms
 * subtitle tolerance is a property of those timings. ElevenLabs returns
 * per-character alignment with the audio; OpenAI's `/v1/audio/speech` returns
 * audio and nothing else.
 *
 * So this adapter recovers the timings itself, by transcribing the audio it just
 * generated with word-level granularity. That is exactly the fallback
 * SpeechSynthesisPort documents — "a provider without native timestamps is
 * adapted by falling back to STT inside its own adapter" — so the port shape
 * never leaks the difference and no stage knows which provider it is on.
 *
 * Two consequences worth stating plainly:
 *
 * 1. **It costs a second call per scene.** Synthesis is billed per character and
 *    alignment per audio-minute; both are metered, so `cost.json` shows the real
 *    total rather than hiding half of it.
 * 2. **The timings are recovered, not authoritative.** Whisper aligns against
 *    audio it did not produce, so a word it mishears lands at the wrong time.
 *    In practice it is aligning speech that was synthesized from text we already
 *    have, which is the easy case — but it is strictly weaker than a
 *    synthesiser reporting its own boundaries, and that is the trade for staying
 *    on one key.
 *
 * Plain `fetch` rather than the vendor SDK: two endpoints, one auth header.
 */
export class OpenAiSpeechSynthesizer implements SpeechSynthesisPort {
  private readonly baseUrl: string;
  /**
   * Constructed here rather than injected: the alignment call is on the same
   * key and the same endpoint as synthesis, so it is not a choice the
   * composition root has anything to say about. The Gemini synthesiser, whose
   * aligner genuinely could be either provider, takes one as an argument.
   */
  private readonly aligner: OpenAiWordAligner;

  constructor(
    private readonly options: OpenAiSpeechOptions,
    private readonly ffmpeg: FfmpegRunner,
    private readonly logger: LoggerPort,
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.aligner = new OpenAiWordAligner({
      apiKey: options.apiKey,
      model: options.alignModel,
      requestTimeoutMs: options.requestTimeoutMs,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    }, logger);
  }

  public async synthesize(input: {
    text: string;
    voice: VoiceProfile;
    outputPath: string;
    signal?: AbortSignal;
  }): Promise<SynthesisResult> {
    await mkdir(dirname(input.outputPath), { recursive: true });

    // WAV rather than MP3: the assembler concatenates raw PCM, and asking for it
    // directly avoids a transcode that would move every timing by a frame or two.
    const audio = await this.speak(input.text, input.voice, input.signal);
    await writeFile(input.outputPath, audio);

    const durationMs = Math.round((await this.ffmpeg.durationSeconds(input.outputPath, input.signal)) * 1000);
    const wordTimings = await this.aligner.align(input.outputPath, input.signal);

    if (wordTimings.length === 0) {
      // Loud: silently falling back to even spacing looks like working sync
      // until a reveal lands a second early and nothing says why.
      this.logger.warn(
        { voice: input.voice.slot, chars: input.text.length },
        'alignment returned no word timings; scene reveals will fall back to inherited timing',
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
   * The four OpenAI voices this service uses, by slot gender.
   *
   * Unlike ElevenLabs ids, OpenAI voice names are public constants rather than
   * account-scoped secrets, so a slot's `.env` value is only consulted when it
   * names one of them — which lets the same `.env` carry ElevenLabs ids and
   * still work when TTS_DRIVER flips to openai.
   */
  private voiceNameFor(voice: VoiceProfile): string {
    const configured = voice.providerVoiceId.toLowerCase();
    if (OPENAI_VOICES.has(configured)) return configured;
    return voice.gender === 'male' ? 'onyx' : 'nova';
  }

  private async speak(text: string, voice: VoiceProfile, signal?: AbortSignal): Promise<Buffer> {
    const response = await this.request('/v1/audio/speech', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.model,
        voice: this.voiceNameFor(voice),
        input: text,
        response_format: 'wav',
      }),
    }, signal);

    return Buffer.from(await response.arrayBuffer());
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable>');
      throw new Error(`OpenAI speech request failed: ${response.status} ${detail.slice(0, 300)}`);
    }
    return response;
  }

  /**
   * OpenAI publishes a fixed voice list rather than an account-scoped library,
   * so there is nothing to query — unlike ElevenLabs, where `listVoices` exists
   * because the answer differs per key.
   */
  public async listVoices(): Promise<readonly VoiceProfile[]> {
    return [];
  }
}

/**
 * Verified against /v1/audio/speech — every name here synthesizes successfully.
 *
 * A name missing from this set does not fail loudly; `voiceNameFor` treats it as
 * another vendor's id and silently substitutes the gender default. So an
 * incomplete list reads as "the configured voice was ignored" rather than as an
 * error, which is why it is kept complete rather than minimal.
 */
const OPENAI_VOICES = new Set([
  'alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'fable',
  'marin', 'onyx', 'nova', 'sage', 'shimmer', 'verse',
]);
