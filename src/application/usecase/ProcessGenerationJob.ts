import type { JobRepositoryPort } from '../port/JobRepositoryPort.js';
import type { WorkspacePort } from '../port/WorkspacePort.js';
import type { ClockPort } from '../port/ClockPort.js';
import type { LoggerPort } from '../port/LoggerPort.js';
import type { CostMeterPort } from '../port/CostMeterPort.js';
import type { GenerationPipeline } from '../pipeline/GenerationPipeline.js';
import type { PipelineContext } from '../pipeline/PipelineContext.js';
import type { ResolvedConfig } from '../pipeline/ResolvedConfig.js';
import type { StageName } from '../pipeline/StageName.js';
import { STAGE_WEIGHTS, STAGE_ORDER, TOTAL_WEIGHT } from '../pipeline/StageName.js';
import type { FinalisedJob, SubmittedSource } from '../pipeline/stage/types.js';
import { JobId } from '@domain/job/JobId.js';
import type { VideoJob } from '@domain/job/VideoJob.js';
import { Progress } from '@domain/job/Progress.js';
import { DomainError } from '@domain/error/DomainError.js';
import { GenerationFailedError } from '@domain/error/GenerationFailedError.js';
import { JobCancelledError } from '../pipeline/JobCancelledError.js';

export interface CostMeterFactory {
  (): CostMeterPort;
}

/**
 * The worker orchestrator. Composes stages, reports progress, maps failures —
 * and contains no business rules of its own. Every decision it makes is about
 * job *state*; every decision about content belongs to a stage or a policy.
 */
export class ProcessGenerationJob {
  constructor(
    private readonly pipeline: GenerationPipeline,
    private readonly repository: JobRepositoryPort,
    private readonly workspace: WorkspacePort,
    private readonly clock: ClockPort,
    private readonly config: ResolvedConfig,
    private readonly logger: LoggerPort,
    private readonly newCostMeter: CostMeterFactory,
  ) {}

  public async execute(rawJobId: string, signal: AbortSignal): Promise<void> {
    const id = JobId.of(rawJobId);
    const job = await this.repository.find(id);

    if (!job) {
      // Nothing to fail — the job state is gone, so the queue entry is stale.
      this.logger.warn({ jobId: rawJobId }, 'queued job has no state; discarding');
      return;
    }
    if (job.isTerminal) {
      this.logger.info({ jobId: rawJobId, status: job.status }, 'job already terminal; skipping');
      return;
    }

    const logger = this.logger.child({ jobId: id.value });
    const costMeter = this.newCostMeter();

    /**
     * A job still marked `processing` here was reclaimed after its previous
     * worker died without releasing it — the queue requeued it, but nothing
     * moved our own state back, because the worker that would have done so is
     * gone. This is the chaos-test path, and it is a resume rather than a fresh
     * start: the checkpoints on the shared workspace are what make it cheap.
     */
    if (job.status === 'processing') {
      logger.info({ attempt: job.attempts, lastStage: job.stage }, 'reclaiming a job abandoned by a dead worker');
      job.requeue(this.clock.now());
    }

    job.start(this.clock.now());
    await this.repository.save(job);

    const ctx = this.buildContext(job, logger, costMeter, signal);

    try {
      const sources = await this.readSubmission(job);
      const result = (await this.pipeline.run(ctx, sources)) as FinalisedJob;

      job.complete({
        artifacts: result.artifacts,
        cost: costMeter.snapshot(result.artifacts.durationSeconds),
        verdict: result.verdict,
        quiz: result.quiz,
        now: this.clock.now(),
      });
      await this.repository.save(job);
      logger.info({ durationSeconds: result.artifacts.durationSeconds }, 'job completed');
    } catch (error) {
      await this.handleFailure(job, error, costMeter, logger, signal);
    }
  }

  private buildContext(
    job: VideoJob,
    logger: LoggerPort,
    costMeter: CostMeterPort,
    signal: AbortSignal,
  ): PipelineContext {
    const clock = this.clock;
    let cancelled = false;

    signal.addEventListener('abort', () => { cancelled = true; }, { once: true });

    return {
      job,
      config: this.config,
      logger,
      costMeter,
      workspace: this.workspace,
      signal,

      reportProgress(stage: StageName, fraction: number): void {
        const completed = STAGE_ORDER
          .slice(0, STAGE_ORDER.indexOf(stage))
          .reduce((total, name) => total + STAGE_WEIGHTS[name], 0);
        const partial = STAGE_WEIGHTS[stage] * Math.min(1, Math.max(0, fraction));
        job.advanceTo(stage, Progress.fromWeights(completed, TOTAL_WEIGHT, partial), clock.now());
      },

      throwIfCancelled(): void {
        if (cancelled || signal.aborted) throw new JobCancelledError(job.id.value);
      },
    };
  }

  private async readSubmission(job: VideoJob): Promise<readonly SubmittedSource[]> {
    const raw = await this.workspace.get(job.id, 'submission.json');
    const parsed = JSON.parse(raw.toString('utf8')) as { sources: SubmittedSource[] };
    return parsed.sources;
  }

  private async handleFailure(
    job: VideoJob,
    error: unknown,
    costMeter: CostMeterPort,
    logger: LoggerPort,
    signal: AbortSignal,
  ): Promise<void> {
    const cost = costMeter.snapshot(0);

    /**
     * Cancellation is not a failure.
     *
     * The abort signal propagates into child processes, so a job cancelled while
     * ffmpeg is running surfaces as ffmpeg's own abort error rather than as
     * JobCancelledError — the stage never reaches its next cancellation check.
     * Any error raised after the signal fired is therefore a *consequence* of
     * cancellation, and classifying it as a generation failure would report a job
     * the caller deliberately stopped as one that broke.
     */
    if (signal.aborted || error instanceof JobCancelledError) {
      logger.info({ jobId: job.id.value }, 'job cancelled mid-flight');

      // Re-read rather than saving the in-memory copy: DELETE mutated the stored
      // job to 'cancelled' while this worker still held a 'processing' version,
      // and writing ours back would silently undo the cancellation.
      const stored = await this.repository.find(job.id);
      const target = stored ?? job;
      if (!target.isTerminal) target.cancel(this.clock.now());
      target.recordCost(cost);

      await this.repository.save(target);
      await this.workspace.discard(job.id);
      return;
    }

    const domainError = error instanceof DomainError
      ? error
      : new GenerationFailedError(
          error instanceof Error ? error.message : String(error),
          job.stage ?? 'unknown',
        );

    // A job below its attempt cap is left 'processing' and rethrown so BullMQ
    // requeues it — checkpoints mean the retry resumes rather than restarts.
    // The workspace is deliberately *not* discarded on a retryable failure.
    const retryable = !(error instanceof DomainError) && job.attempts < this.config.jobMaxAttempts;
    if (retryable) {
      logger.warn({ err: error, attempt: job.attempts }, 'job failed; leaving for retry');
      throw error;
    }

    job.fail(
      { code: domainError.code, message: domainError.message, details: domainError.details },
      this.clock.now(),
      cost,
    );
    await this.repository.save(job);
    await this.workspace.discard(job.id);

    logger.error({ err: error, code: domainError.code }, 'job failed terminally');
  }
}
