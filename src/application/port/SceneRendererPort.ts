import type { Storyboard } from '@domain/script/Storyboard.js';
import type { VisualPlan } from '@domain/media/VisualPlan.js';

export interface RenderSegment {
  readonly index: number;
  readonly startFrame: number;
  readonly endFrame: number;
}

export interface RenderedSegment {
  readonly index: number;
  readonly path: string;
  readonly frameCount: number;
  readonly wallSeconds: number;
}

/**
 * Seek, screenshot, encode. A job's frame range splits across segments so render
 * is resumable per segment rather than per job.
 */
export interface SceneRendererPort {
  planSegments(storyboard: Storyboard, maxSegments: number): readonly RenderSegment[];

  renderSegment(input: {
    storyboard: Storyboard;
    segment: RenderSegment;
    outputPath: string;
    /**
     * The video's agreed palette. Overrides the theme's colours for this job, so
     * scenes agree with each other rather than each inventing a scheme.
     */
    visualPlan?: VisualPlan;
    signal?: AbortSignal;
  }): Promise<RenderedSegment>;
}
