import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import type { StoryPlanJudgePort } from '../../port/StoryPlanJudgePort.js';
import type { ScriptGeneratorPort } from '../../port/ScriptGeneratorPort.js';
import type { PlanCritique } from '@domain/quality/PlanCritique.js';
import type { NarrationScript } from '@domain/script/NarrationScript.js';
import type { ScriptAssembler } from './ScriptAssembler.js';
import type { ScriptedContent } from './types.js';

/** The plan and the verdict that let it through, so the better of two can win. */
interface Attempt {
  readonly script: NarrationScript;
  readonly critique: PlanCritique;
  readonly attempt: number;
}

/**
 * The story is graded before a single board is drawn.
 *
 * Everything downstream judges *execution*: the scene judge looks at a rendered
 * board and asks whether it is legible, grounded and well composed. None of it
 * can ask whether the video should have had this scene at all, or whether scene
 * two needed something scene five explains — and by the time a board exists
 * those answers are settled. A beautifully drawn board of the wrong idea passes
 * every gate there is.
 *
 * So the plan is reviewed here, where a rejection costs one text call and a
 * rewrite, rather than at the end, where it would cost an illustrated, judged
 * and rendered video. This is also the cheapest stage that can send work
 * backwards, which is why it sits immediately after the script rather than
 * after the storyboard: the further downstream a rewrite starts, the more paid
 * work it throws away.
 *
 * **The better plan ships, and the video always ships.** A revision that comes
 * back with more objections than the original is discarded and the original is
 * kept — the same rule the scene judge learned when it was destroying attempt
 * N-1 the moment attempt N returned. A plan that never satisfies the judge is
 * still a script: it goes on with its objections recorded, because a video
 * about the right material with a weak second scene is worth more to a student
 * than a failed job.
 *
 * Skipped entirely when the caller turned it off, and when the pipeline is
 * running on stubs there is nothing to judge — the stub judge approves, which
 * keeps the no-credentials path honest rather than pretending to review.
 */
export class ReviewStoryPlanStage implements PipelineStage<ScriptedContent, ScriptedContent> {
  public readonly name: StageName = 'planReview';

  constructor(
    private readonly judge: StoryPlanJudgePort,
    private readonly generator: ScriptGeneratorPort,
    private readonly assembler: ScriptAssembler,
  ) {}

  public async execute(input: ScriptedContent, ctx: PipelineContext): Promise<ScriptedContent> {
    if (!ctx.job.features.planReview) {
      ctx.logger.info('story plan review disabled for this job; going straight to the boards');
      return input;
    }

    const { duration } = ctx.config.policies;
    const target = duration.targetFor(input.content.stats, ctx.job.targetDuration);
    const maxRevisions = ctx.config.judge.maxPlanRevisions;

    let best: Attempt | undefined;
    let script = input.script;

    for (let attempt = 0; ; attempt += 1) {
      ctx.throwIfCancelled();

      const judgement = await this.judge.judgePlan({
        script,
        content: input.content,
        targetDuration: target,
        // The caller's steer is part of the standard: "focus on the exam
        // questions" makes a plan that covers everything evenly the *wrong*
        // plan, and a judge that has not been told cannot know that.
        ...(ctx.job.direction ? { direction: ctx.job.direction.text } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      ctx.costMeter.recordTokens(this.name, judgement.usage);

      const critique = judgement.critique;
      const candidate: Attempt = { script, critique, attempt };
      if (!best || isBetter(candidate, best)) best = candidate;

      if (critique.approved) {
        ctx.logger.info(
          { attempt, score: critique.score, scenes: script.scenes.length },
          'story plan approved',
        );
        return { ...input, script: best.script };
      }

      if (attempt >= maxRevisions) {
        // Loud: the video that ships was knowingly rejected by its own reviewer,
        // and the objections are the most useful thing in the log when someone
        // later asks why scene three is thin.
        ctx.logger.warn(
          {
            attempts: attempt + 1,
            shippedAttempt: best.attempt,
            issues: best.critique.kinds,
            notes: best.critique.notes.slice(0, 5),
          },
          'story plan still has objections after its last revision; shipping the best plan',
        );
        return { ...input, script: best.script };
      }

      ctx.logger.info(
        { attempt, issues: critique.kinds, notes: critique.notes.slice(0, 5) },
        'story plan rejected; revising',
      );

      script = await this.revise(input, critique, ctx);
    }
  }

  /**
   * A fresh script written against the same brief with the objections attached.
   *
   * It goes through `ScriptAssembler`, which means a revision faces exactly the
   * same source-scoping and citation checks the original did. That is the point
   * of the assembler existing: a rewrite prompted by a quality critique is
   * precisely the situation in which a model starts writing fluent sentences the
   * material does not support.
   */
  private async revise(
    input: ScriptedContent,
    critique: PlanCritique,
    ctx: PipelineContext,
  ): Promise<NarrationScript> {
    const { duration, personalisation } = ctx.config.policies;
    const language = ctx.job.outputLanguage;
    const brief = personalisation.resolve(ctx.job.studentContext, ctx.job.style, ctx.job.direction);
    const target = duration.targetFor(input.content.stats, ctx.job.targetDuration);

    const result = await this.generator.generate({
      content: input.content,
      outputLanguage: language,
      targetDuration: target,
      wordBudget: duration.wordBudgetFor(target, language.code),
      brief,
      imageSources: ctx.job.features.imageSources,
      revisionNotes: critique.notes,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    ctx.costMeter.recordTokens(this.name, result.usage);

    return this.assembler.assemble({ result, language, brief, stage: this.name, ctx });
  }
}

/**
 * Fewer objections wins; the score only breaks ties.
 *
 * The same ordering the scene judge uses, for the same reason: the score is a
 * model's opinion and drifts between runs, so it decides nothing on its own —
 * but between two plans the judge objected to equally often it is the only
 * signal there is, and using it there costs nothing.
 */
function isBetter(candidate: Attempt, incumbent: Attempt): boolean {
  const a = candidate.critique;
  const b = incumbent.critique;
  if (a.issues.length !== b.issues.length) return a.issues.length < b.issues.length;
  return (a.score ?? 0) > (b.score ?? 0);
}
