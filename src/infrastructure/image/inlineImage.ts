import sharp from 'sharp';
import type { SceneImage, ImageAttribution } from '@domain/media/SceneImage.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';
import { SceneImage as Image } from '@domain/media/SceneImage.js';

/**
 * The board is 1280x720 and the plate is a fraction of it, so nothing above
 * this width is ever seen. A 4000px original inlined verbatim is ~4MB of base64
 * in the page, which Chromium decodes on every one of the scene's frames.
 */
const MAX_WIDTH = 1100;
const MAX_HEIGHT = 800;

/**
 * WebP at 82: visually indistinguishable at this size and roughly a quarter of
 * the JPEG bytes. Chromium is the only consumer, so there is no compatibility
 * argument for JPEG.
 */
const QUALITY = 82;

/**
 * Bytes from a stock library → an image a board can carry.
 *
 * Every adapter ends here, which is the point: the resize, the re-encode and
 * the base64 are identical work whichever library found the picture, and the
 * size cap is a rendering constraint rather than a vendor one. Doing it per
 * adapter is how three of them end up with three different ceilings.
 *
 * Re-encoding also strips EXIF, which is worth stating plainly: stock
 * photographs carry camera serial numbers and GPS coordinates, and this service
 * publishes its output.
 */
export async function inlineImage(input: {
  bytes: Buffer;
  alt: string;
  attribution: ImageAttribution;
  source: ImageSourceId;
}): Promise<SceneImage> {
  const resized = sharp(input.bytes)
    .rotate()                               // honour EXIF orientation before it is stripped
    .resize({
      width: MAX_WIDTH,
      height: MAX_HEIGHT,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: QUALITY });

  const { data, info } = await resized.toBuffer({ resolveWithObject: true });

  return Image.of({
    dataUri: `data:image/webp;base64,${data.toString('base64')}`,
    alt: input.alt,
    attribution: input.attribution,
    width: info.width,
    height: info.height,
    source: input.source,
  });
}
