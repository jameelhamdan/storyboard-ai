import type { NarrationScript } from '@domain/script/NarrationScript.js';
import type { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import type { PlanCritique } from '@domain/quality/PlanCritique.js';
import type { Duration } from '@domain/shared/Duration.js';
import type { TokenUsage } from './CostMeterPort.js';

export interface PlanJudgement {
  readonly critique: PlanCritique;
  readonly usage: TokenUsage;
}

/**
 * Grades the story before anything is drawn.
 *
 * Separate from `QualityJudgePort` because it is a different job on different
 * input: that one looks at a screenshot of one finished board, this one reads
 * the whole script against the whole source and answers "is this the right set
 * of scenes, in the right order, each shaped the right way". Folding them into
 * one port would give both callers a method neither of them can use.
 */
export interface StoryPlanJudgePort {
  judgePlan(input: {
    script: NarrationScript;
    content: ConsolidatedContent;
    targetDuration: Duration;
    /** The caller's free-text steer, so the review grades against what was asked for. */
    direction?: string;
    signal?: AbortSignal;
  }): Promise<PlanJudgement>;
}
