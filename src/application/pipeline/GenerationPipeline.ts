import type { PipelineStage } from './PipelineStage.js';
import type { PipelineContext } from './PipelineContext.js';
import {
  STAGE_ORDER, STAGE_WEIGHTS, TOTAL_WEIGHT, CHECKPOINT_KEY, OPTIONAL_STAGES, type StageName,
} from './StageName.js';
import { carryToJson, carryFromJson, type CarryJson } from './codec.js';
import { GenerationFailedError } from '@domain/error/GenerationFailedError.js';
import { DomainError } from '@domain/error/DomainError.js';
import { JobCancelledError } from './JobCancelledError.js';
import { Progress } from '@domain/job/Progress.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- the stage list is heterogeneous by nature: each stage's input is the previous stage's output, which no single generic signature expresses. The types are enforced at each stage's own definition. */
export type AnyStage = PipelineStage<any, any>;

/** Called after every stage, completed or resumed past. Persisting this is what makes GET /status real. */
export type OnStageComplete = (stage: StageName, progress: Progress, ctx: PipelineContext) => Promise<void> | void;

interface Checkpoint {
  readonly completed: StageName[];
  readonly carry: CarryJson;
}

/**
 * Composes the stages. Contains no business rules — every decision it makes is
 * about orchestration: what runs next, what was already done, what to do when a
 * stage throws.
 *
 * Resume reads one checkpoint document listing the stages already finished, so a
 * requeued job restarts at the first stage not in that list rather than re-paying
 * for LLM and TTS calls already made.
 */
export class GenerationPipeline {
  private readonly stages: ReadonlyMap<StageName, AnyStage>;

  constructor(stages: readonly AnyStage[], private readonly onStageComplete: OnStageComplete) {
    const byName = new Map<StageName, AnyStage>();
    for (const stage of stages) byName.set(stage.name, stage);

    const missing = STAGE_ORDER.filter((name) => !byName.has(name) && !OPTIONAL_STAGES.has(name));
    if (missing.length > 0) {
      throw new Error(`GenerationPipeline is missing stages: ${missing.join(', ')}.`);
    }
    this.stages = byName;
  }

  public async run(ctx: PipelineContext, seed: unknown): Promise<unknown> {
    const resumed = await this.readCheckpoint(ctx);
    const done = new Set<StageName>(resumed?.completed ?? []);

    let carried: unknown = resumed
      ? carryFromJson(resumed.carry, ctx.job.qualityPreset, ctx.config.audio.interSceneGapMs)
      : seed;
    let completedWeight = 0;

    for (const name of STAGE_ORDER) {
      ctx.throwIfCancelled();
      this.assertWithinCostCeiling(ctx, name);

      const weight = STAGE_WEIGHTS[name];

      if (done.has(name)) {
        completedWeight += weight;
        ctx.logger.info({ stage: name }, 'stage skipped — already in the checkpoint');
        await this.onStageComplete(name, Progress.fromWeights(completedWeight, TOTAL_WEIGHT), ctx);
        continue;
      }

      /**
       * An optional stage this deployment did not wire.
       *
       * Its weight is still credited, because the weights are the progress scale
       * and the API contract says the percentage reaches 100. Dropping the
       * weight along with the stage would make every credential-free run finish
       * at 97%.
       */
      const stage = this.stages.get(name);
      if (!stage) {
        completedWeight += weight;
        ctx.logger.debug({ stage: name }, 'stage not configured for this deployment — skipped');
        await this.onStageComplete(name, Progress.fromWeights(completedWeight, TOTAL_WEIGHT), ctx);
        continue;
      }

      const startedAt = Date.now();
      try {
        carried = await stage.execute(carried, ctx);
      } catch (error) {
        throw this.wrap(error, name);
      }

      done.add(name);
      await this.writeCheckpoint(ctx, { completed: [...done], carry: carryToJson(carried) });

      completedWeight += weight;
      const progress = Progress.fromWeights(completedWeight, TOTAL_WEIGHT);
      ctx.logger.info({ stage: name, ms: Date.now() - startedAt, progress: progress.percent }, 'stage complete');
      await this.onStageComplete(name, progress, ctx);
    }

    return carried;
  }

  private async readCheckpoint(ctx: PipelineContext): Promise<Checkpoint | undefined> {
    if (!(await ctx.workspace.has(ctx.job.id, CHECKPOINT_KEY))) return undefined;
    const raw = await ctx.workspace.get(ctx.job.id, CHECKPOINT_KEY);
    return JSON.parse(raw.toString('utf8')) as Checkpoint;
  }

  private async writeCheckpoint(ctx: PipelineContext, checkpoint: Checkpoint): Promise<void> {
    await ctx.workspace.put(
      ctx.job.id, CHECKPOINT_KEY, Buffer.from(JSON.stringify(checkpoint), 'utf8'),
    );
  }

  /**
   * The per-job circuit breaker (plan.md §1, §7).
   *
   * Checked at stage boundaries rather than inside stages: a runaway
   * regeneration loop is the realistic way a job burns money, and the retry
   * budget alone bounds retries per scene, not total spend across stages.
   *
   * It fails the job rather than degrading it. A job that has already spent more
   * than its ceiling and is only part-way through will not get cheaper by
   * continuing, and finishing it would bill the overspend twice over.
   */
  private assertWithinCostCeiling(ctx: PipelineContext, next: StageName): void {
    const policy = ctx.config.policies.costCeiling;
    const spent = ctx.costMeter.snapshot(0);

    if (policy.hasBreached(spent)) {
      throw new GenerationFailedError(
        `Job exceeded its cost ceiling of $${policy.ceilingUsd.toFixed(2)} ` +
        `(spent $${spent.total.toUsdRounded(4)}) before stage '${next}'.`,
        next,
        { spent_usd: spent.total.toUsdRounded(4), ceiling_usd: policy.ceilingUsd },
      );
    }
  }

  /**
   * Domain errors carry their own code and pass through untouched — an
   * INSUFFICIENT_CONTENT must not be relabelled as a generic failure. Everything
   * else becomes GENERATION_FAILED tagged with the stage that produced it.
   */
  private wrap(error: unknown, stage: StageName): Error {
    // Cancellation and domain errors both carry meaning the caller acts on, so
    // neither may be relabelled as a generic failure.
    if (error instanceof JobCancelledError) return error;
    if (error instanceof DomainError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new GenerationFailedError(message, stage);
    if (error instanceof Error && error.stack) wrapped.stack = error.stack;
    return wrapped;
  }
}
