import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAiSpeechSynthesizer } from '@infrastructure/speech/OpenAiSpeechSynthesizer.js';
import { VoiceProfile } from '@domain/media/VoiceProfile.js';
import { Language } from '@domain/shared/Language.js';
import type { FfmpegRunner } from '@infrastructure/encode/FfmpegRunner.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';

const noop = () => {};
const logger = {
  info: noop, warn: noop, error: noop, debug: noop, trace: noop, child: () => logger,
} as unknown as LoggerPort;

/** Reports a fixed duration; the real runner shells out to ffprobe. */
const ffmpeg = { durationSeconds: async () => 3.5 } as unknown as FfmpegRunner;

const options = {
  apiKey: 'sk-test', model: 'gpt-4o-mini-tts',
  alignModel: 'whisper-1', requestTimeoutMs: 5000,
};

const voice = (gender: 'female' | 'male', providerVoiceId: string) => VoiceProfile.of({
  slot: `en_${gender}_1`, language: Language.of('en'), gender, providerVoiceId,
});

/** Records every outbound request so we can assert on the wire shape. */
function stubOpenAi(words: { word: string; start: number; end: number }[] = []) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];

  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    if (String(url).endsWith('/v1/audio/speech')) {
      calls.push({ url: String(url), body: JSON.parse(init.body as string), headers });
      return new Response(Buffer.from('RIFFfake-wav-bytes'), { status: 200 });
    }
    calls.push({ url: String(url), body: init.body, headers });
    return new Response(JSON.stringify({ duration: 3.5, words }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });

  return calls;
}

afterEach(() => vi.unstubAllGlobals());

/**
 * OpenAI's speech endpoint returns audio and nothing else, so this adapter has
 * to recover word timings itself by transcribing what it just generated. That
 * second call is the whole reason the adapter is more than a fetch — these
 * tests pin the parts that would silently produce a correct-looking video with
 * no working timeline.
 */
describe('OpenAiSpeechSynthesizer', () => {
  it('requests WAV so the assembler is not re-transcoding, and writes the bytes', async () => {
    const calls = stubOpenAi([{ word: 'glucose', start: 0.1, end: 0.6 }]);
    const dir = await mkdtemp(join(tmpdir(), 'tts-'));
    const outputPath = join(dir, 'scene-0.wav');

    const result = await new OpenAiSpeechSynthesizer(options, ffmpeg, logger)
      .synthesize({ text: 'makes glucose', voice: voice('female', 'nova'), outputPath });

    const speech = calls.find((c) => c.url.endsWith('/v1/audio/speech'))!;
    expect((speech.body as { response_format: string }).response_format).toBe('wav');
    expect(speech.headers['authorization']).toBe('Bearer sk-test');
    expect((await readFile(outputPath)).toString()).toContain('fake-wav-bytes');
    expect(result.audioPath).toBe(outputPath);
  });

  it('recovers word timings from its own audio via a second transcription call', async () => {
    stubOpenAi([
      { word: 'makes', start: 0.0, end: 0.4 },
      { word: 'glucose', start: 0.5, end: 1.2 },
    ]);
    const dir = await mkdtemp(join(tmpdir(), 'tts-'));

    const result = await new OpenAiSpeechSynthesizer(options, ffmpeg, logger)
      .synthesize({ text: 'makes glucose', voice: voice('female', 'nova'), outputPath: join(dir, 'a.wav') });

    expect(result.wordTimings.map((w) => w.word)).toEqual(['makes', 'glucose']);
    expect(result.wordTimings[0]!.start.ms).toBe(0);
    expect(result.wordTimings[1]!.end.ms).toBe(1200);
    // Duration comes from the measured file, not from the model's own claim.
    expect(result.durationMs).toBe(3500);
    expect(result.characterCount).toBe('makes glucose'.length);
  });

  it('asks for word-level granularity — without it the response carries no timings', async () => {
    const calls = stubOpenAi();
    const dir = await mkdtemp(join(tmpdir(), 'tts-'));

    await new OpenAiSpeechSynthesizer(options, ffmpeg, logger)
      .synthesize({ text: 'hi', voice: voice('female', 'nova'), outputPath: join(dir, 'a.wav') });

    const align = calls.find((c) => c.url.endsWith('/v1/audio/transcriptions'))!;
    const form = align.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toContain('word');
  });

  it('keeps the audio when alignment fails rather than discarding paid-for synthesis', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).endsWith('/v1/audio/speech')
        ? new Response(Buffer.from('RIFFfake'), { status: 200 })
        : new Response('upstream exploded', { status: 500 }));

    const dir = await mkdtemp(join(tmpdir(), 'tts-'));
    const result = await new OpenAiSpeechSynthesizer(options, ffmpeg, logger)
      .synthesize({ text: 'hi', voice: voice('female', 'nova'), outputPath: join(dir, 'a.wav') });

    expect(result.wordTimings).toEqual([]);
    expect(result.durationMs).toBe(3500);
  });

  it('fails loudly when synthesis itself fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('bad key', { status: 401 }));
    const dir = await mkdtemp(join(tmpdir(), 'tts-'));

    await expect(new OpenAiSpeechSynthesizer(options, ffmpeg, logger)
      .synthesize({ text: 'hi', voice: voice('female', 'nova'), outputPath: join(dir, 'a.wav') }))
      .rejects.toThrow(/401/);
  });

  it('falls back to a gender-appropriate voice when the slot holds another vendor\'s id', async () => {
    const calls = stubOpenAi();
    const dir = await mkdtemp(join(tmpdir(), 'tts-'));
    const synth = new OpenAiSpeechSynthesizer(options, ffmpeg, logger);

    // The VOICE_* keys hold ElevenLabs ids, which OpenAI would reject outright.
    await synth.synthesize({ text: 'hi', voice: voice('male', 'HKFOb9iktHA85uKXydRT'), outputPath: join(dir, 'm.wav') });
    await synth.synthesize({ text: 'hi', voice: voice('female', 'XfNU2rGpBa01ckF309OY'), outputPath: join(dir, 'f.wav') });

    const voices = calls
      .filter((c) => c.url.endsWith('/v1/audio/speech'))
      .map((c) => (c.body as { voice: string }).voice);
    expect(voices).toEqual(['onyx', 'nova']);
  });

  it('uses the configured id verbatim when it already names an OpenAI voice', async () => {
    const calls = stubOpenAi();
    const dir = await mkdtemp(join(tmpdir(), 'tts-'));

    await new OpenAiSpeechSynthesizer(options, ffmpeg, logger)
      .synthesize({ text: 'hi', voice: voice('female', 'Shimmer'), outputPath: join(dir, 'a.wav') });

    const speech = calls.find((c) => c.url.endsWith('/v1/audio/speech'))!;
    expect((speech.body as { voice: string }).voice).toBe('shimmer');
  });
});
