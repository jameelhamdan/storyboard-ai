import type { IllustrationFinderPort, ImageQuery } from '@application/port/ImageSourcePort.js';
import type { SceneImage } from '@domain/media/SceneImage.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import { traceContours } from '../render/diagram/traceContours.js';

/**
 * Turns a found diagram into the strokes that drew it.
 *
 * The board's aesthetic is that everything is drawn: an SVG path with
 * `pathLength="1"` advances its stroke along its own geometry, so a line appears
 * to be written. Every element the renderer lays out gets that for free — except
 * a found picture, which arrives as pixels and can only switch on.
 *
 * Tracing closes that gap **without generating anything**. It is measurement,
 * not invention: the contours are the ones already in the image, so what gets
 * drawn is the published figure itself, and the credit under it stays true.
 *
 * A decorator over the finder rather than a step inside it, because it is a
 * different job — the finder decides *which library answers*, this decides *how
 * the answer is drawn* — and because a deployment that wants flat pictures
 * simply does not wrap.
 *
 * **Only diagrams, and only when the trace is clean.** A photograph traces into
 * a few hundred meaningless fragments, so it is never attempted for a photo
 * query and is discarded when the result does not look like line art. Both
 * checks matter: a "diagram" query can still come back with a photograph.
 */
export class TracingIllustrationFinder implements IllustrationFinderPort {
  constructor(
    private readonly inner: IllustrationFinderPort,
    private readonly logger: LoggerPort,
  ) {}

  public get available(): readonly ImageSourceId[] {
    return this.inner.available;
  }

  public async find(query: ImageQuery): Promise<SceneImage | undefined> {
    const image = await this.inner.find(query);
    if (!image || query.kind !== 'diagram') return image;

    const bytes = bytesOf(image);
    if (!bytes) return image;

    /**
     * A failed or unclean trace is not a failed board. The picture is already
     * found, already correct and already credited; showing it flat costs the
     * scene some character rather than costing it a picture.
     */
    const tracing = await traceContours({ bytes }).catch(() => undefined);
    if (!tracing) {
      this.logger.debug(
        { query: query.query, source: image.source },
        'image did not trace into clean line art; showing it as found',
      );
      return image;
    }

    this.logger.info(
      { query: query.query, source: image.source, strokes: tracing.paths.length },
      'illustration will be drawn stroke by stroke',
    );
    return image.withTracing(tracing);
  }
}

/** The inlined image, back as bytes. `SceneImage` only ever holds a data URI. */
function bytesOf(image: SceneImage): Buffer | undefined {
  const base64 = /^data:[^;]+;base64,(.*)$/.exec(image.dataUri)?.[1];
  return base64 ? Buffer.from(base64, 'base64') : undefined;
}
