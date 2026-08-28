import type { StoryPlanJudgePort, PlanJudgement } from '@application/port/StoryPlanJudgePort.js';
import type { LlmClientPort } from '@application/port/LlmClientPort.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import type { NarrationScript } from '@domain/script/NarrationScript.js';
import type { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import type { Duration } from '@domain/shared/Duration.js';
import { PlanCritique, PLAN_ISSUES, type PlanIssueKind } from '@domain/quality/PlanCritique.js';
import type { PromptLibrary } from './PromptLibrary.js';
import { planJudgeSchema } from './schemas.js';

interface PlanJudgeResponse {
  approved?: boolean;
  score?: number;
  summary?: string;
  issues?: { kind?: string; sceneIndex?: number; note?: string }[];
}

/**
 * Quality tier, and not negotiable.
 *
 * This call reads the whole source against the whole plan and decides whether
 * the video teaches its material — the same class of judgement as writing the
 * script, made once per job. The volume tier is for calls that are numerous and
 * checked downstream; this one is neither, and a cheap model reviewing a plan
 * reliably approves it, which is worse than not reviewing at all because it
 * costs money to learn nothing.
 */
export class PromptedStoryPlanJudge implements StoryPlanJudgePort {
  constructor(
    private readonly client: LlmClientPort,
    private readonly prompts: PromptLibrary,
    private readonly logger: LoggerPort,
  ) {}

  public async judgePlan(input: {
    script: NarrationScript;
    content: ConsolidatedContent;
    targetDuration: Duration;
    direction?: string;
    signal?: AbortSignal;
  }): Promise<PlanJudgement> {
    const prompt = this.prompts.render('09-story-plan-judge', {
      target_duration_seconds: Math.round(input.targetDuration.seconds),
      output_language: input.script.language.code,
      direction: input.direction ?? 'none',
      material: input.content.chunks.map((chunk) => `[${chunk.id}] ${chunk.text}`).join('\n\n'),
      plan: this.planText(input.script),
    });

    const result = await this.client.generate<PlanJudgeResponse>({
      system: prompt.system,
      user: prompt.user,
      tier: 'quality',
      responseSchema: planJudgeSchema as unknown as Record<string, unknown>,
      maxOutputTokens: 4096,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    return { critique: this.critiqueFrom(result.parsed), usage: result.usage };
  }

  /**
   * The plan as the judge reads it: one line per scene, narration and shape.
   *
   * Deliberately not the storyboard or the visual plan. Those describe how a
   * board will look, and looking is what every other judge in this pipeline
   * already does — showing them here invites a review of the design instead of
   * the teaching, which is the one review nothing else performs.
   */
  private planText(script: NarrationScript): string {
    return script.scenes
      .map((scene) => [
        `Scene ${scene.index} — visualIntent: ${scene.visualIntent}`,
        scene.writtenText,
      ].join('\n'))
      .join('\n\n');
  }

  /**
   * A judgement that did not parse is treated as an approval, not a rejection.
   *
   * The asymmetry is deliberate. A failed review must not be able to trigger a
   * rewrite — that spends a quality-tier call on the strength of a response
   * nobody could read, and it can do it on every attempt. Failing open here
   * means a broken judge costs the review, and nothing else.
   */
  private critiqueFrom(parsed: PlanJudgeResponse | undefined): PlanCritique {
    if (!parsed) {
      this.logger.warn('story plan judge returned nothing readable; treating the plan as approved');
      return PlanCritique.of({ approved: true, issues: [] });
    }

    const issues = (parsed.issues ?? [])
      .map((issue) => ({
        kind: toIssueKind(issue.kind),
        ...(typeof issue.sceneIndex === 'number' ? { sceneIndex: issue.sceneIndex } : {}),
        note: (issue.note ?? '').trim(),
      }))
      .filter((issue) => issue.kind !== undefined && issue.note.length > 0)
      .map((issue) => ({ ...issue, kind: issue.kind as PlanIssueKind }));

    return PlanCritique.of({
      approved: parsed.approved === true,
      issues,
      ...(typeof parsed.score === 'number' ? { score: parsed.score } : {}),
      ...(parsed.summary ? { summary: parsed.summary } : {}),
    });
  }
}

/**
 * An unrecognised `kind` drops the issue rather than filing it under a guess.
 *
 * The kind is what makes a note actionable — it tells the rewrite whether to
 * look at one scene or at the scene list — so an issue with an invented
 * category is an objection with no address, and shipping it would send a
 * rewrite at nothing in particular.
 */
function toIssueKind(raw: string | undefined): PlanIssueKind | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  return (PLAN_ISSUES as readonly string[]).includes(value) ? (value as PlanIssueKind) : undefined;
}
