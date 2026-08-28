import type { ImageSourceId } from './ImageSourceId.js';
import type { TracedArtwork } from './TracedArtwork.js';

/**
 * How the image is licensed, in the terms the credit line has to satisfy.
 *
 * Kept as free text rather than an enum because it is quoted, not reasoned
 * about: Wikimedia alone serves a dozen licences, and the obligation they share
 * is that the name appears next to the work.
 */
export interface ImageAttribution {
  /** Who made it. Required — every source this service uses demands it. */
  readonly author: string;
  /** Where it came from, in a word: `Unsplash`, `Wikimedia Commons`, `Pexels`. */
  readonly sourceName: string;
  /** The page a viewer would visit to verify the credit. */
  readonly sourceUrl: string;
  /** `CC BY-SA 4.0`, `Unsplash License`, `Pexels License`. */
  readonly licence: string;
}

/**
 * A found image, already fetched and inlined, ready to be drawn on a board.
 *
 * **The bytes travel with the object.** `dataUri` is the whole image, resized
 * and re-encoded before it got here. That is not an optimisation — the renderer
 * aborts every request whose scheme is not `data:`, deliberately, so a remote
 * URL on a board renders as a broken image and nothing says why. An image that
 * cannot be inlined is an image this service will not use.
 *
 * **Attribution is not optional and not separable.** Every source we search
 * requires credit, and making it a required field of the same object as the
 * pixels is what stops a refactor shipping the picture without the credit line.
 */
export class SceneImage {
  private constructor(
    public readonly dataUri: string,
    public readonly alt: string,
    public readonly attribution: ImageAttribution,
    public readonly width: number,
    public readonly height: number,
    /**
     * Which library it came from.
     *
     * Not merely a duplicate of `attribution.sourceName`, which is prose for a
     * viewer: this is the id a request names, a cost line counts and a renderer
     * decides on. A generated drawing and a photograph are treated differently
     * downstream — one can be traced into strokes, the other cannot — and
     * inferring that from a display string would be guessing.
     */
    public readonly source: ImageSourceId,
    /**
     * The strokes that draw this picture, when it is the kind of picture that
     * can be drawn.
     *
     * Present on generated line art and absent on photographs, which trace into
     * a few hundred meaningless fragments. When it is here the renderer draws
     * the strokes instead of showing the image, and the board gains the one
     * property every other element already has: it appears by being drawn.
     */
    public readonly tracing: TracedArtwork | undefined,
  ) {}

  public static of(input: {
    dataUri: string;
    alt: string;
    attribution: ImageAttribution;
    width: number;
    height: number;
    source: ImageSourceId;
  }): SceneImage {
    if (!input.dataUri.startsWith('data:image/')) {
      throw new Error('A scene image must be an inlined data: URI — see SceneImage.');
    }
    if (!input.attribution.author.trim() || !input.attribution.sourceName.trim()) {
      throw new Error('A scene image must carry its author and source.');
    }
    return new SceneImage(
      input.dataUri,
      input.alt.trim(),
      input.attribution,
      input.width,
      input.height,
      input.source,
      undefined,
    );
  }

  /**
   * The same image with its strokes worked out.
   *
   * Separate from `of` for the same reason `SceneDiagram.withImage` is: tracing
   * is work that can fail and can be skipped, and validation is neither.
   */
  public withTracing(tracing: TracedArtwork): SceneImage {
    return new SceneImage(
      this.dataUri, this.alt, this.attribution,
      this.width, this.height, this.source, tracing,
    );
  }

  /** Drawn to order rather than found. Credited differently, and traceable. */
  public get isGenerated(): boolean {
    return this.source === 'generated';
  }

  /** The credit line as it appears under the picture. */
  public get credit(): string {
    const { author, sourceName, licence } = this.attribution;
    return `${author} / ${sourceName} · ${licence}`;
  }

  /** Landscape images fill the plate; portrait ones sit beside the callouts. */
  public get isPortrait(): boolean {
    return this.height > this.width;
  }
}
