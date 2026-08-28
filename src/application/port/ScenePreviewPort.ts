import type { Scene } from '@domain/script/Scene.js';
import type { VisualPlan } from '@domain/media/VisualPlan.js';

export interface ScenePreview {
  /** The image written, or `undefined` when previewing is unavailable. */
  readonly path: string | undefined;
  /**
   * What is wrong with the board's geometry, measured rather than judged.
   *
   * Overlap, clipping and undersized text used to be one clause inside a vision
   * gate, which is how a board whose centre box covered its neighbour passed all
   * five gates with a holistic 4. They are properties of a laid-out page, so the
   * page can answer them — for nothing, deterministically, and without the model
   * having to notice.
   *
   * Empty when the preview could not be taken: absence of evidence is not a
   * failure, and failing a scene because a screenshot did not work would turn a
   * rendering problem into a rejected board.
   */
  readonly layoutFailures: readonly string[];
}

/**
 * Renders one scene to a still image so it can be judged as a picture rather
 * than as markup, and measures what the picture can be asked about directly.
 *
 * Separate from `SceneRendererPort` on purpose: that one produces timed video
 * segments and is the expensive path. This captures a single frame at the moment
 * everything has arrived, which is what a reviewer would look at.
 *
 * The measurement rides along with the screenshot rather than living in its own
 * check because both need the same laid-out page, and loading it twice would
 * double the only slow part of Stage A.
 */
export interface ScenePreviewPort {
  capture(input: {
    scene: Scene;
    outputPath: string;
    visualPlan?: VisualPlan;
    /** The job's frame size, so the preview matches what will be rendered. */
    width?: number;
    height?: number;
    /** Below this, in rem, text is too small to read at 720p. */
    minFontRem?: number;
    signal?: AbortSignal;
  }): Promise<ScenePreview>;
}
