import { describe, it, expect, vi, afterEach } from 'vitest';
import sharp from 'sharp';
import { GeneratedImageSource } from '@infrastructure/image/GeneratedImageSource.js';
import { GeminiImageGenerator } from '@infrastructure/image/GeminiImageGenerator.js';
import { inlineImage } from '@infrastructure/image/inlineImage.js';
import type { ImageGeneratorPort, GeneratedImage } from '@application/port/ImageGeneratorPort.js';
import type { IllustrationFinderPort, ImageQuery } from '@application/port/ImageSourcePort.js';
import type { SceneImage } from '@domain/media/SceneImage.js';
import { createLogger } from '@infrastructure/observability/logger.js';

const logger = createLogger({ level: 'silent', redactPaths: [] });

afterEach(() => vi.unstubAllGlobals());

const png = async (width = 600, height = 400) =>
  sharp({ create: { width, height, channels: 3, background: '#cccccc' } }).png().toBuffer();

const reference = async (): Promise<SceneImage> => inlineImage({
  bytes: await png(),
  alt: 'a micrograph of stomata',
  attribution: {
    author: 'A Botanist',
    sourceName: 'Wikimedia Commons',
    sourceUrl: 'https://commons.example/File:Stomata.jpg',
    licence: 'CC BY-SA 4.0',
  },
  source: 'wikimedia',
});

function finderReturning(image: SceneImage | undefined): IllustrationFinderPort & { calls: ImageQuery[] } {
  const calls: ImageQuery[] = [];
  return {
    available: ['wikimedia'],
    calls,
    async find(query) { calls.push(query); return image; },
  };
}

function generatorThat(
  behaviour: 'draws' | 'refuses',
): ImageGeneratorPort & { calls: { prompt: string; reference?: GeneratedImage }[] } {
  const calls: { prompt: string; reference?: GeneratedImage }[] = [];
  return {
    model: 'test-image-model',
    calls,
    async generate(input) {
      calls.push({ prompt: input.prompt, ...(input.reference ? { reference: input.reference } : {}) });
      if (behaviour === 'refuses') throw new Error('the model declined');
      return { bytes: await png(800, 600), mimeType: 'image/png' };
    },
  };
}

const options = { styleBrief: 'Style: a marker drawing on a whiteboard.' };

/**
 * Asked for "a diagram of the Krebs cycle" with nothing to work from, an image
 * model invents a plausible-looking one, labels included — which is precisely
 * the failure this service exists to avoid. Grounding it on a published figure
 * turns generation into restyling something already correct.
 */
describe('GeneratedImageSource', () => {
  it('searches for a reference and hands it to the model', async () => {
    const found = await reference();
    const references = finderReturning(found);
    const generator = generatorThat('draws');

    const result = await new GeneratedImageSource(generator, options, logger, references)
      .find({ query: 'stomata', kind: 'diagram' });

    expect(references.calls).toHaveLength(1);
    expect(generator.calls[0]?.reference).toBeDefined();
    expect(generator.calls[0]?.prompt).toContain('Redraw the attached image');
    expect(result?.source).toBe('generated');
  });

  it('draws from the description when no reference was found', async () => {
    const generator = generatorThat('draws');

    const result = await new GeneratedImageSource(generator, options, logger, finderReturning(undefined))
      .find({ query: 'stomata', kind: 'diagram' });

    expect(generator.calls[0]?.reference).toBeUndefined();
    expect(generator.calls[0]?.prompt).toContain('stomata');
    expect(result?.source).toBe('generated');
  });

  /**
   * The photograph was already found and already correct. Returning undefined
   * would send the composite off to search the same libraries again for a worse
   * answer than the one already in hand.
   */
  it('ships the reference unchanged when the model refuses', async () => {
    const found = await reference();

    const result = await new GeneratedImageSource(generatorThat('refuses'), options, logger, finderReturning(found))
      .find({ query: 'stomata', kind: 'diagram' });

    expect(result?.source).toBe('wikimedia');
    expect(result?.attribution.author).toBe('A Botanist');
  });

  it('finds nothing when it can neither draw nor fall back', async () => {
    const result = await new GeneratedImageSource(
      generatorThat('refuses'), options, logger, finderReturning(undefined),
    ).find({ query: 'stomata', kind: 'diagram' });

    expect(result).toBeUndefined();
  });

  /**
   * An AI drawing that reads as a photograph is the one dishonesty available
   * here, and the person whose picture it was derived from does not stop being
   * owed a credit.
   */
  it('credits itself as generated, and names whose work it was drawn from', async () => {
    const result = await new GeneratedImageSource(
      generatorThat('draws'), options, logger, finderReturning(await reference()),
    ).find({ query: 'stomata', kind: 'diagram' });

    expect(result?.credit).toContain('test-image-model');
    expect(result?.attribution.licence).toContain('AI-generated from A Botanist');
    expect(result?.isGenerated).toBe(true);
  });

  it('carries the theme style and the scene concept into the prompt', async () => {
    const generator = generatorThat('draws');

    await new GeneratedImageSource(generator, options, logger, finderReturning(undefined))
      .find({ query: 'stomata', kind: 'diagram', styleNote: 'the pore opens as guard cells swell' });

    expect(generator.calls[0]?.prompt).toContain('marker drawing on a whiteboard');
    expect(generator.calls[0]?.prompt).toContain('the pore opens as guard cells swell');
  });

  /**
   * Labels are the renderer's job — it lays out callouts as HTML beside the
   * plate, where they wrap, get measured and meet the legibility floor. Text
   * baked into the picture does none of that.
   */
  it('asks for no text in the picture', async () => {
    const generator = generatorThat('draws');

    await new GeneratedImageSource(generator, options, logger, finderReturning(undefined))
      .find({ query: 'stomata', kind: 'diagram' });

    expect(generator.calls[0]?.prompt).toMatch(/no labels/i);
  });

  it('works with no reference finder at all', async () => {
    const result = await new GeneratedImageSource(generatorThat('draws'), options, logger)
      .find({ query: 'stomata', kind: 'diagram' });

    expect(result?.source).toBe('generated');
  });
});

describe('GeminiImageGenerator', () => {
  it('sends the reference inline beside the prompt and asks for an image back', async () => {
    const seen: any[] = [];
    vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const generator = new GeminiImageGenerator({
      apiKey: 'k', model: 'test-image', requestTimeoutMs: 5000, baseUrl: 'https://gen.example',
    }, logger);

    const result = await generator.generate({
      prompt: 'redraw this',
      reference: { bytes: Buffer.from('hello'), mimeType: 'image/webp' },
    });

    expect(seen[0].url).toBe('https://gen.example/v1beta/models/test-image:generateContent');
    expect(seen[0].body.generationConfig.responseModalities).toEqual(['IMAGE']);
    expect(seen[0].body.contents[0].parts[1].inlineData.mimeType).toBe('image/webp');
    expect(result.bytes.toString('base64')).toBe('AAAA');
  });

  /** A refusal is a 200 with no image part; the caller's fallback depends on knowing that. */
  it('names a refusal rather than returning empty bytes', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const generator = new GeminiImageGenerator({
      apiKey: 'k', model: 'test-image', requestTimeoutMs: 5000, baseUrl: 'https://gen.example',
    }, logger);

    await expect(generator.generate({ prompt: 'x' })).rejects.toThrow(/returned no image: SAFETY/);
  });
});
