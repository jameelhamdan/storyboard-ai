import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { TracingIllustrationFinder } from '@infrastructure/image/TracingIllustrationFinder.js';
import { inlineImage } from '@infrastructure/image/inlineImage.js';
import type { IllustrationFinderPort, ImageQuery } from '@application/port/ImageSourcePort.js';
import type { SceneImage } from '@domain/media/SceneImage.js';
import { createLogger } from '@infrastructure/observability/logger.js';

const logger = createLogger({ level: 'silent', redactPaths: [] });

/** A published figure: clean strokes on a light ground. */
const lineArt = (): Promise<Buffer> => sharp(Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">'
  + '<rect width="800" height="600" fill="#ffffff"/>'
  + '<circle cx="400" cy="300" r="180" fill="none" stroke="#000000" stroke-width="8"/>'
  + '<rect x="220" y="120" width="360" height="360" fill="none" stroke="#000000" stroke-width="8"/>'
  + '</svg>',
)).png().toBuffer();

/**
 * A photograph, approximated by dense noise — which is what a photograph looks
 * like to a contour tracer: hundreds of fragments of shadow and texture.
 */
async function photograph(): Promise<Buffer> {
  const width = 300;
  const height = 200;
  const pixels = Buffer.alloc(width * height);

  // Deterministic pseudo-noise — a hash per pixel, so neighbours are
  // uncorrelated and the test cannot flake on a lucky seed. A simple modular
  // sequence will not do: it produces diagonal stripes, which trace into a
  // handful of long clean contours, which is the opposite of the point.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      pixels[y * width + x] = (h ^ (h >>> 16)) & 255;
    }
  }

  return sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

const imageOf = async (bytes: Buffer): Promise<SceneImage> => inlineImage({
  bytes,
  alt: 'a figure',
  attribution: {
    author: 'A Contributor',
    sourceName: 'Wikimedia Commons',
    sourceUrl: 'https://commons.example/File:Figure.png',
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

/**
 * The board's aesthetic is that everything is drawn. A found picture is the one
 * element that would merely switch on — tracing closes that gap by *measuring*
 * the picture, not by generating a second one, so the credit under it stays
 * true.
 */
describe('TracingIllustrationFinder', () => {
  it('draws a found diagram as strokes', async () => {
    const found = await imageOf(await lineArt());

    const result = await new TracingIllustrationFinder(finderReturning(found), logger)
      .find({ query: 'a figure', kind: 'diagram' });

    expect(result?.tracing).toBeDefined();
    expect(result!.tracing!.paths.length).toBeGreaterThan(0);
  });

  /** A photograph traces into noise, which is strictly worse than the photograph. */
  it('leaves a photograph alone even on a diagram query', async () => {
    const found = await imageOf(await photograph());

    const result = await new TracingIllustrationFinder(finderReturning(found), logger)
      .find({ query: 'a photo', kind: 'diagram' });

    expect(result?.tracing).toBeUndefined();
  });

  it('never traces a photo query', async () => {
    const found = await imageOf(await lineArt());

    const result = await new TracingIllustrationFinder(finderReturning(found), logger)
      .find({ query: 'a figure', kind: 'photo' });

    expect(result?.tracing).toBeUndefined();
  });

  /** Drawing the picture does not make it ours. */
  it('keeps the credit exactly as the library gave it', async () => {
    const found = await imageOf(await lineArt());

    const result = await new TracingIllustrationFinder(finderReturning(found), logger)
      .find({ query: 'a figure', kind: 'diagram' });

    expect(result?.attribution).toEqual(found.attribution);
    expect(result?.source).toBe('wikimedia');
  });

  it('passes the query through untouched, and finds nothing when the inner finder does', async () => {
    const inner = finderReturning(undefined);

    const result = await new TracingIllustrationFinder(inner, logger)
      .find({ query: 'nothing', kind: 'diagram', sources: ['wikimedia'] });

    expect(result).toBeUndefined();
    expect(inner.calls[0]).toMatchObject({ query: 'nothing', sources: ['wikimedia'] });
  });

  it('reports the libraries the deployment can reach', () => {
    expect(new TracingIllustrationFinder(finderReturning(undefined), logger).available)
      .toEqual(['wikimedia']);
  });
});
