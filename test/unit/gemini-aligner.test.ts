import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiWordAligner } from '@infrastructure/speech/align/GeminiWordAligner.js';
import { createLogger } from '@infrastructure/observability/logger.js';

const logger = createLogger({ level: 'silent', redactPaths: [] });
afterEach(() => vi.unstubAllGlobals());

const NARRATION = 'Glucose is split into pyruvate today';

async function audioFile(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'align-')), 'scene.wav');
  await writeFile(path, Buffer.from('RIFF-not-really-a-wav'));
  return path;
}

const aligner = () => new GeminiWordAligner({
  apiKey: 'k', model: 'test-model', requestTimeoutMs: 5000, baseUrl: 'https://gen.example',
}, logger);

/** Replies with whatever word list the test wants. */
function replying(words: unknown): unknown[] {
  const seen: unknown[] = [];
  vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
    seen.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ words }) }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return seen;
}

const spoken = [
  { word: 'Glucose', start: 0.08, end: 0.72 },
  { word: 'is', start: 0.94, end: 1.12 },
  { word: 'split', start: 1.12, end: 1.52 },
  { word: 'into', start: 1.52, end: 1.88 },
  { word: 'pyruvate', start: 1.88, end: 2.56 },
  { word: 'today', start: 2.56, end: 3.0 },
];

/**
 * Alignment, not transcription. The narration was synthesized from text we
 * still hold, so there is nothing to mishear — the task is placing known words
 * on a known waveform, which is the easier problem and the more trustworthy
 * answer.
 */
describe('GeminiWordAligner', () => {
  it('tells the model the words, so it places rather than guesses them', async () => {
    const seen = replying(spoken) as any[];

    await aligner().align({ audioPath: await audioFile(), text: NARRATION });

    const prompt = seen[0].contents[0].parts[0].text;
    expect(prompt).toContain(NARRATION);
    expect(prompt).toMatch(/do not add, remove, reorder or correct/i);
    expect(seen[0].contents[0].parts[1].inlineData.mimeType).toBe('audio/wav');
    // Placing words on a waveform has one right answer.
    expect(seen[0].generationConfig.temperature).toBe(0);
  });

  it('returns the timings in milliseconds', async () => {
    replying(spoken);

    const timings = await aligner().align({ audioPath: await audioFile(), text: NARRATION });

    expect(timings).toHaveLength(6);
    expect(timings[0]?.word).toBe('Glucose');
    expect(Math.round(timings[0]!.start.ms)).toBe(80);
    expect(Math.round(timings[4]!.end.ms)).toBe(2560);
  });

  /**
   * A plausible wrong timeline is worse than none: every reveal on every board
   * resolves against it, so it desynchronises the video with nothing reporting
   * why. Falling back to inherited timing is visibly plainer, not silently wrong.
   */
  it('discards a timeline that runs backwards', async () => {
    replying([
      { word: 'Glucose', start: 2.0, end: 2.4 },
      { word: 'is', start: 0.5, end: 0.9 },
    ]);

    expect(await aligner().align({ audioPath: await audioFile(), text: NARRATION })).toEqual([]);
  });

  it('discards a timeline missing most of the narration', async () => {
    replying([{ word: 'Glucose', start: 0.1, end: 0.5 }]);

    expect(await aligner().align({ audioPath: await audioFile(), text: NARRATION })).toEqual([]);
  });

  it('skips a single unusable word rather than the whole line', async () => {
    replying([
      ...spoken.slice(0, 5),
      { word: '   ', start: 2.6, end: 2.9 },
      { word: 'today', start: 2.9, end: 3.2 },
    ]);

    const timings = await aligner().align({ audioPath: await audioFile(), text: NARRATION });
    expect(timings).toHaveLength(6);
  });

  /** The audio is already correct and already paid for. */
  it('returns nothing rather than throwing when the call fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));

    expect(await aligner().align({ audioPath: await audioFile(), text: NARRATION })).toEqual([]);
  });

  it('still works when no text was supplied, as plain transcription', async () => {
    const seen = replying(spoken) as any[];

    const timings = await aligner().align({ audioPath: await audioFile() });

    expect(seen[0].contents[0].parts[0].text).toContain('Transcribe this audio');
    expect(timings).toHaveLength(6);
  });
});
