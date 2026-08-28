import type { Scene } from '@domain/script/Scene.js';
import type { TimelineAnchor } from '@domain/script/SceneTimeline.js';
import type { GateId } from '@domain/quality/QualityScore.js';
import type { TokenUsage } from './CostMeterPort.js';
import type { VisualPlan } from '@domain/media/VisualPlan.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';

export interface GeneratedStoryboard {
  /**
   * True when this is the built-in last-resort board rather than the model's.
   *
   * Reported rather than inferred: a silently substituted fallback renders as a
   * plain scene that looks like a deliberate choice, and a run summary saying
   * "fallback 0" while half the video is stub bullets is worse than no summary.
   */
  readonly usedFallback?: boolean;
  readonly sceneIndex: number;
  readonly html: string;
  readonly anchors: readonly TimelineAnchor[];
  readonly usage: TokenUsage;
  /**
   * How many illustrations this board had drawn for it — 0 or 1 today.
   *
   * Reported rather than inferred because it is billed per image, and the stage
   * that holds the cost meter is not the thing that knows whether a picture was
   * searched for or drawn.
   */
  readonly imagesGenerated?: number;
}

export interface StoryboardGeneratorPort {
  /** Batched — the LLM sees several scenes at once so style stays consistent (G5). */
  generate(input: {
    scenes: readonly Scene[];
    /**
     * The video's agreed design. Without it each scene invents its own palette
     * and the video reads as ten unrelated videos spliced together.
     */
    visualPlan?: VisualPlan;
    /**
     * The caller's free-text steer, verbatim.
     *
     * It reaches the illustrator as well as the writer because it changes what
     * a *picture* should show, not only what the narration says — "use real lab
     * photographs where you can" and "keep it abstract" are both instructions
     * about boards, and the visual plan's per-scene concept compresses them
     * away.
     */
    direction?: string;
    /**
     * The image libraries this job permits, already intersected with what the
     * deployment can reach. Empty means every board is drawn.
     */
    imageSources?: readonly ImageSourceId[];
    signal?: AbortSignal;
  }): Promise<readonly GeneratedStoryboard[]>;

  /** Targeted regeneration: the failed gate ids tell the model what to fix. */
  regenerate(input: {
    scene: Scene;
    failedGates: readonly GateId[];
    notes: readonly string[];
    visualPlan?: VisualPlan;
    direction?: string;
    imageSources?: readonly ImageSourceId[];
    signal?: AbortSignal;
  }): Promise<GeneratedStoryboard>;

  /** The documented escape hatch when the retry budget is exhausted. */
  fallback(scene: Scene): GeneratedStoryboard;
}
