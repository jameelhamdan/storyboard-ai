import type { StoryPlanJudgePort, PlanJudgement } from '@application/port/StoryPlanJudgePort.js';
import { PlanCritique } from '@domain/quality/PlanCritique.js';

/**
 * Approves every plan, and says so by having nothing to say.
 *
 * The stub path exists so the whole pipeline runs with no credentials and no
 * spend, and the honest behaviour for a reviewer with no model behind it is to
 * pass the plan through unchanged. Inventing objections would send the stub
 * script generator into a rewrite loop against a critique nobody wrote; scoring
 * it would put a number in the logs that means nothing.
 */
export class StubStoryPlanJudge implements StoryPlanJudgePort {
  public async judgePlan(): Promise<PlanJudgement> {
    return {
      critique: PlanCritique.of({
        approved: true,
        issues: [],
        summary: 'Not reviewed: no model provider is configured.',
      }),
      usage: { inputTokens: 0, outputTokens: 0, model: 'stub' },
    };
  }
}
