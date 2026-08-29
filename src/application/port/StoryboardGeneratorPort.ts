import type { Scene } from '@domain/script/Scene.js';
import type { Board } from '@domain/script/Board.js';
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
  /**
   * The board this markup is for, by its first scene's index.
   *
   * Kept as a scene index rather than a board ordinal so a result can still be
   * matched up when boards are regrouped — the grouping is derived from the
   * scenes and a board's ordinal moves if an earlier continuation breaks.
   */
  readonly sceneIndex: number;
  /** Every scene the board covers. One entry for a board that is a single scene. */
  readonly sceneIndexes?: readonly number[];
  /** One document for the whole build; every scene on the board shares it. */
  readonly html: string;
  /** Across the whole board. Each anchor names the step it belongs to. */
  readonly anchors: readonly TimelineAnchor[];
  readonly usage: TokenUsage;
}

export interface StoryboardGeneratorPort {
  /**
   * One call per **board**, not per scene.
   *
   * A board is one diagram built over its scenes, so describing it once is both
   * the only coherent way to author it — the model has to see the whole build to
   * decide what arrives when — and considerably cheaper than describing it per
   * scene, since the shape guidance and the design brief are sent once for the
   * board instead of once for each of its scenes.
   */
  generate(input: {
    boards: readonly Board[];
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
    board: Board;
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
