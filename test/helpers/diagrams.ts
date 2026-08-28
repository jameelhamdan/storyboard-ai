import sharp from 'sharp';
import { SceneImage } from '@domain/media/SceneImage.js';
import { SceneDiagram, type ImageBrief } from '@domain/script/SceneDiagram.js';

/**
 * A real, tiny image, so tests that render an `illustration` render the same
 * markup production does.
 *
 * Generated rather than checked in: the plate's layout depends on the image's
 * aspect ratio (`isPortrait` picks a different grid), so a test needs to be able
 * to ask for a shape, and a fixture file would only ever have one.
 */
export async function testImage(
  width = 800,
  height = 600,
): Promise<SceneImage> {
  const png = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 200, b: 210 } },
  }).webp().toBuffer();

  return SceneImage.of({
    dataUri: `data:image/webp;base64,${png.toString('base64')}`,
    alt: 'a test image',
    attribution: {
      author: 'A Photographer',
      sourceName: 'Wikimedia Commons',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Test.webp',
      licence: 'CC BY-SA 4.0',
    },
    width,
    height,
    source: 'wikimedia',
  });
}

/** Every `illustration` needs one, and it is the same one everywhere. */
export const TEST_IMAGE_BRIEF: ImageBrief = {
  query: 'a test subject',
  kind: 'photo',
  alt: 'a test image',
};

/**
 * `SceneDiagram.of` plus the two things only `illustration` needs — the brief it
 * is rejected without, and the found image it renders as nothing without.
 *
 * Every test that walks `DIAGRAM_SHAPES` goes through here, so a shape added
 * later with its own requirements has one place to satisfy them rather than
 * five.
 */
export async function diagramFor(
  input: Parameters<typeof SceneDiagram.of>[0],
): Promise<SceneDiagram> {
  if (input.shape !== 'illustration') return SceneDiagram.of(input);

  const diagram = SceneDiagram.of({ ...input, imageBrief: TEST_IMAGE_BRIEF });
  return diagram.withImage(await testImage());
}
