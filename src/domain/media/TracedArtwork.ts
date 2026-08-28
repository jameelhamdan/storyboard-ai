/**
 * A picture reduced to the strokes that draw it.
 *
 * The board's whole aesthetic is that things are *drawn*: an SVG path with
 * `pathLength="1"` advances its stroke along its own geometry, so a line appears
 * to be written rather than to fade in. Everything the renderer lays out gets
 * that for free — except a found or generated picture, which arrives as pixels
 * and can only appear.
 *
 * Tracing closes that gap. The contours are computed **once, at storyboard
 * time**, and stored in the scene's markup, which is the property that matters:
 * every frame stays a pure function of the frame number, so a segment
 * re-rendered on another worker is pixel-identical and the resume guarantee is
 * untouched. Tracing per frame would have broken both.
 */
export class TracedArtwork {
  private constructor(
    /** The coordinate space the path data is expressed in. */
    public readonly viewBox: string,
    /** SVG `d` attributes, in drawing order — longest stroke first. */
    public readonly paths: readonly string[],
  ) {}

  public static of(input: {
    width: number;
    height: number;
    paths: readonly string[];
  }): TracedArtwork {
    const paths = input.paths.filter((path) => path.trim().length > 0);
    if (paths.length === 0) {
      throw new Error('A traced artwork needs at least one stroke.');
    }
    return new TracedArtwork(`0 0 ${input.width} ${input.height}`, paths);
  }
}
