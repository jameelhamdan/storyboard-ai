import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import type { ObjectStoragePort } from '../../port/ObjectStoragePort.js';
import type { AssembledVideo, FinalisedJob } from './types.js';
import { RunArtifacts } from './RunArtifacts.js';

/**
 * MP4 + SRT + traceability.json + cost.json to object storage, presigned — and
 * the last thing the pipeline does, so it also closes the job out: records the
 * final cost and reclaims the workspace.
 *
 * The traceability sidecar (FR-13) is what makes citations useful beyond the
 * pipeline boundary: every narration sentence that states a source fact, its
 * video timestamp, and the SourceRefs it derives from. Not rendered in the
 * video, per FR-13 — but it is what a hallucination audit runs against and what
 * the future citation overlay would read.
 *
 * `narration` is the scene's *sourced* text and `spoken_narration` is everything
 * the voice said. They differ when the script used its teaching allowance, and
 * keeping both means an auditor can see the claim set without losing the ability
 * to check it against what a viewer actually heard.
 */
export class PublishArtifactsStage implements PipelineStage<AssembledVideo, FinalisedJob> {
  public readonly name: StageName = 'publish';

  constructor(
    private readonly storage: ObjectStoragePort,
    /**
     * Off in production. When on, the run's intermediates are reorganised per
     * scene and the workspace is kept — see `RunArtifacts`.
     */
    private readonly runArtifacts: RunArtifacts = new RunArtifacts(false),
  ) {}

  public async execute(input: AssembledVideo, ctx: PipelineContext): Promise<FinalisedJob> {
    // Before publishing rather than after: this reads the workspace, and
    // publishing is the step that makes the workspace collectable.
    await this.runArtifacts.write(input, ctx);

    const prefix = `${ctx.config.storage.prefix}${ctx.job.id.value}`;
    const ttl = ctx.config.storage.presignTtlSeconds;

    const traceabilityKey = '12-traceability/traceability.json';
    await ctx.workspace.put(
      ctx.job.id,
      traceabilityKey,
      Buffer.from(JSON.stringify(this.buildTraceability(input, ctx), null, 2), 'utf8'),
    );
    const localTraceability = await ctx.workspace.localCopy(ctx.job.id, traceabilityKey);

    const [video, subtitles, traceability] = await Promise.all([
      this.storage.put({
        key: `${prefix}/video.mp4`,
        localPath: await ctx.workspace.localCopy(ctx.job.id, input.videoKey),
        contentType: 'video/mp4',
      }),
      this.storage.put({
        key: `${prefix}/subtitles.srt`,
        localPath: await ctx.workspace.localCopy(ctx.job.id, input.subtitleKey),
        contentType: 'application/x-subrip',
      }),
      this.storage.put({
        key: `${prefix}/traceability.json`,
        localPath: localTraceability,
        contentType: 'application/json',
      }),
    ]);

    ctx.costMeter.recordStorage(this.name, video.sizeBytes + subtitles.sizeBytes + traceability.sizeBytes);

    // Snapshotted here, after the three artifacts above are metered, so the
    // report accounts for its own siblings. It cannot account for itself — the
    // bytes of cost.json are recorded below, once its size is known — so the
    // file says so rather than reporting a number that is quietly short.
    const costKey = '12-traceability/cost.json';
    await ctx.workspace.put(
      ctx.job.id,
      costKey,
      Buffer.from(JSON.stringify(this.buildCostReport(input, ctx), null, 2), 'utf8'),
    );
    const cost = await this.storage.put({
      key: `${prefix}/cost.json`,
      localPath: await ctx.workspace.localCopy(ctx.job.id, costKey),
      contentType: 'application/json',
    });
    ctx.costMeter.recordStorage(this.name, cost.sizeBytes);

    const [videoUrl, subtitleUrl, traceabilityUrl, costUrl] = await Promise.all([
      this.storage.presignedUrl(video.key, ttl),
      this.storage.presignedUrl(subtitles.key, ttl),
      this.storage.presignedUrl(traceability.key, ttl),
      this.storage.presignedUrl(cost.key, ttl),
    ]);

    ctx.logger.info({ prefix }, 'artifacts published');

    const finalCost = ctx.costMeter.snapshot(input.durationSeconds);
    ctx.job.recordCost(finalCost);

    const perMinute = finalCost.perMinute.usd;
    ctx.logger.info({
      totalUsd: finalCost.total.toUsdRounded(),
      perMinuteUsd: Number(perMinute.toFixed(4)),
      durationSeconds: input.durationSeconds,
      units: finalCost.breakdown.totalUnits(),
    }, 'job cost finalised');

    // Exceeding the target does not fail a finished video, but it is the number
    // the pricing tier is measured on, so it must be impossible to miss.
    const target = ctx.config.costTargetPerMinuteUsd;
    if (perMinute > target) {
      ctx.logger.warn({
        perMinuteUsd: Number(perMinute.toFixed(4)),
        targetUsd: target,
      }, 'cost per video-minute exceeded the target');
    }

    // Cleanup for the happy path; the worker's failure handler and the orphan
    // sweeper cover failure and sudden death respectively.
    await ctx.workspace.discard(ctx.job.id);

    return {
      artifacts: {
        videoUrl, subtitleUrl, traceabilityUrl, costUrl,
        durationSeconds: input.durationSeconds,
      },
      quiz: input.quiz,
      verdict: input.verdict,
    };
  }

  /**
   * Token usage and spend, split by the vendor that will invoice for it.
   *
   * Metadata only — student content must never reach a cost record, and the
   * meter has no method that could accept any, so this file is structurally
   * incapable of carrying a fragment of the source.
   */
  private buildCostReport(input: AssembledVideo, ctx: PipelineContext): Record<string, unknown> {
    const snapshot = ctx.costMeter.snapshot(input.durationSeconds);
    return {
      job_id: ctx.job.id.value,
      generated_at: new Date().toISOString(),
      video_duration_seconds: input.durationSeconds,
      note:
        'Costs are estimates from the configured pricing table, not billed amounts. ' +
        'Storage excludes this file itself, whose size is not known until it is written.',
      ...snapshot.toJSON(),
    };
  }

  private buildTraceability(input: AssembledVideo, ctx: PipelineContext): Record<string, unknown> {
    return {
      job_id: ctx.job.id.value,
      language: ctx.job.outputLanguage.code,
      generated_at: new Date().toISOString(),
      scenes: input.storyboard.scenes.map((scene) => {
        const window = input.storyboard.windowFor(scene.index);
        return {
          scene_index: scene.index,
          start_seconds: window ? Number(window.start.seconds.toFixed(3)) : null,
          end_seconds: window ? Number(window.end.seconds.toFixed(3)) : null,
          // The assertions only. Narration may also contain a capped number of
          // teaching sentences — a hook, an analogy, a transition — which state
          // nothing about the subject and cite nothing; recording them here as
          // sourced claims is the one way this could weaken the audit.
          narration: scene.sourcedText,
          spoken_narration: scene.writtenText,
          citations: scene.citations.map((c) => c.toJSON()),
        };
      }),
      quiz: input.quiz.map((q) => ({
        ...q.toJSON(),
        citations: q.citations.map((c) => c.toJSON()),
      })),
      conflicts: input.content.conflicts,
    };
  }
}
