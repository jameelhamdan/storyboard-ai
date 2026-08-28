import type { VisualPlan } from '@domain/media/VisualPlan.js';
import type { NarrationScript } from '@domain/script/NarrationScript.js';
import type { Language } from '@domain/shared/Language.js';
import type { TokenUsage } from './CostMeterPort.js';

export interface VisualPlanResult {
  readonly plan: VisualPlan;
  readonly usage: TokenUsage;
}

/**
 * Designs the whole video before any scene is implemented.
 *
 * One call for the whole script rather than one per scene: the point is
 * agreement between scenes, and a per-scene planner could not produce it.
 */
export interface VisualPlannerPort {
  plan(input: {
    script: NarrationScript;
    outputLanguage: Language;
    subject: string;
    /** The style's visual sentence — how dense the boards should be. */
    styleNote: string;
    /** The caller's free-text steer for this video, if any. */
    direction?: string;
    signal?: AbortSignal;
  }): Promise<VisualPlanResult>;
}
