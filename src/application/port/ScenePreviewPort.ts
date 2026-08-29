import type { Board } from '@domain/script/Board.js';
import type { VisualPlan } from '@domain/media/VisualPlan.js';

export interface BoardPreview {
  /**
   * One image per step of the build, in order, or empty when previewing is
   * unavailable.
   *
   * A built board cannot be judged from a single frame. The last step shows
   * every element on the board at once, which says nothing about whether the
   * third one arrived when the narration needed it or whether the second was
   * still legible underneath it. So the judge is shown the board *as the viewer
   * meets it*: one frame at the end of each step.
   *
   * A single-step board yields exactly one image, which is what it always did.
   */
  readonly paths: readonly string[];
  /**
   * What is wrong with the board's geometry, measured rather than judged.
   *
   * Overlap, clipping and undersized text used to be one clause inside a vision
   * gate, which is how a board whose centre box covered its neighbour passed all
   * five gates with a holistic 4. They are properties of a laid-out page, so the
   * page can answer them — for nothing, deterministically, and without the model
   * having to notice.
   *
   * **Measured once for the whole board**, and that is sound rather than a
   * shortcut: a step changes an element's `visibility`, never its box, so the
   * board's geometry is identical at every step of the build. Measuring per
   * step would cost N page loads to produce N copies of one answer.
   *
   * Empty when the preview could not be taken: absence of evidence is not a
   * failure, and failing a board because a screenshot did not work would turn a
   * rendering problem into a rejected board.
   */
  readonly layoutFailures: readonly string[];
}

/**
 * Renders a board to still images so it can be judged as a picture rather than
 * as markup, and measures what the picture can be asked about directly.
 *
 * Separate from `SceneRendererPort` on purpose: that one produces timed video
 * segments and is the expensive path. This captures one settled frame per step,
 * which is what a reviewer would look at.
 *
 * The measurement rides along with the screenshots rather than living in its own
 * check because both need the same laid-out page, and loading it twice would
 * double the only slow part of Stage A.
 */
export interface BoardPreviewPort {
  capture(input: {
    board: Board;
    /** Where the image for a given 1-based step should be written. */
    outputPathFor: (step: number) => string;
    visualPlan?: VisualPlan;
    /** The job's frame size, so the preview matches what will be rendered. */
    width?: number;
    height?: number;
    /** Below this, in rem, text is too small to read at 720p. */
    minFontRem?: number;
    signal?: AbortSignal;
  }): Promise<BoardPreview>;
}
