import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenerationPipeline, type AnyStage, type OnStageComplete } from '@application/pipeline/GenerationPipeline.js';
import { STAGE_ORDER, STAGE_WEIGHTS, TOTAL_WEIGHT, CHECKPOINT_KEY } from '@application/pipeline/StageName.js';
import type { PipelineContext } from '@application/pipeline/PipelineContext.js';
import type { PipelineStage } from '@application/pipeline/PipelineStage.js';
import { SharedVolumeWorkspace } from '@infrastructure/storage/SharedVolumeWorkspace.js';
import { CostMeter, DEFAULT_PRICING, type ProviderNames } from '@infrastructure/observability/CostMeter.js';
import { CostCeilingPolicy } from '@domain/policy/CostCeilingPolicy.js';
import { Money } from '@domain/shared/Money.js';
import { JobFeatures } from '@domain/job/JobFeatures.js';
import { VideoJob } from '@domain/job/VideoJob.js';
import { Language } from '@domain/shared/Language.js';
import { QualityPreset } from '@domain/media/QualityPreset.js';
import { VideoStyle } from '@domain/media/VideoStyle.js';
import { InsufficientContentError } from '@domain/error/InsufficientContentError.js';
import { GenerationFailedError } from '@domain/error/GenerationFailedError.js';
import { JobCancelledError } from '@application/pipeline/JobCancelledError.js';

const style = VideoStyle.of({
  name: 'explainer', label: 'Explainer',
  narration: 'Warm and clear, addressed to one learner.',
  visual: 'One idea per board, room to breathe.',
});

const preset = QualityPreset.of({ name: 'standard', width: 1280, height: 720, fps: 24, codec: 'h264', crf: 23 });

/** A stage that records that it ran, so we can assert on what was skipped. */
function recordingStage(name: typeof STAGE_ORDER[number], ran: string[], behaviour?: () => never): AnyStage {
  const stage: PipelineStage<unknown, unknown> = {
    name,
    async execute(input: unknown) {
      ran.push(name);
      behaviour?.();
      return { seen: input, from: name };
    },
  };
  return stage;
}

function buildContext(workspaceRoot: string, job: VideoJob, ceilingUsd = 2.0): PipelineContext {
  const noop = () => {};
  return {
    job,
    config: {
      policies: { costCeiling: new CostCeilingPolicy(ceilingUsd) },
      audio: { interSceneGapMs: 0 },
    } as unknown as PipelineContext['config'],
    logger: { info: noop, warn: noop, error: noop, debug: noop, child: () => ({ info: noop, warn: noop, error: noop, debug: noop }) } as unknown as PipelineContext['logger'],
    costMeter: new CostMeter(DEFAULT_PRICING, TEST_PROVIDERS),
    workspace: new SharedVolumeWorkspace(workspaceRoot),
    signal: new AbortController().signal,
    reportProgress: noop,
    throwIfCancelled: noop,
  };
}

const silentHooks: OnStageComplete = () => {};

const TEST_PROVIDERS: ProviderNames = {
  llm: 'stub', tts: 'stub', stt: 'stub',
  rendering: 'ffmpeg', storage: 'local', embeddings: 'stub', images: 'none', search: 'none',
};

describe('stage weights', () => {
  it('sum to 100, so progress_percent means what the contract says', () => {
    expect(TOTAL_WEIGHT).toBe(100);
  });

  it('cover every stage in the documented order', () => {
    expect(STAGE_ORDER).toHaveLength(Object.keys(STAGE_WEIGHTS).length);
  });

  it('gives render the largest share, because it does the most work', () => {
    const heaviest = Object.entries(STAGE_WEIGHTS).sort((a, b) => b[1] - a[1])[0];
    expect(heaviest?.[0]).toBe('render');
  });
});

describe('GenerationPipeline', () => {
  let root: string;
  let job: VideoJob;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'scgen-pipeline-'));
    job = VideoJob.create({
      outputLanguage: Language.of('en'), voiceSlot: 'en_female_1',
      qualityPreset: preset, style,
      features: JobFeatures.of({ images: true, imageSources: ['wikimedia'], planReview: true }),
      now: new Date(),
    });
  });

  it('refuses to construct with a missing stage', () => {
    expect(() => new GenerationPipeline([], silentHooks)).toThrow(/missing stages/);
  });

  it('runs every stage in order and threads output to input', async () => {
    const ran: string[] = [];
    const pipeline = new GenerationPipeline(STAGE_ORDER.map((n) => recordingStage(n, ran)), silentHooks);

    await pipeline.run(buildContext(root, job), { seed: true });

    expect(ran).toEqual([...STAGE_ORDER]);
  });

  /**
   * The chaos test in miniature: a worker dies mid-job, the job is requeued, and
   * the replacement must resume from the last checkpoint rather than re-paying
   * for the LLM and TTS calls already made.
   */
  it('resumes from the last checkpoint instead of restarting', async () => {
    const firstRun: string[] = [];
    const failAt = 'synthesize' as const;

    const crashing = new GenerationPipeline(
      STAGE_ORDER.map((n) => recordingStage(n, firstRun, n === failAt
        ? () => { throw new Error('worker died'); }
        : undefined)),
      silentHooks,
    );

    await expect(crashing.run(buildContext(root, job), { seed: true })).rejects.toThrow(/worker died/);
    expect(firstRun).toContain('script');
    expect(firstRun).not.toContain('render');

    // A different worker picks the job up; same shared workspace.
    const secondRun: string[] = [];
    const recovering = new GenerationPipeline(
      STAGE_ORDER.map((n) => recordingStage(n, secondRun)),
      silentHooks,
    );
    await recovering.run(buildContext(root, job), { seed: true });

    // Everything before the crash is skipped — no re-spend on script or storyboard.
    expect(secondRun).not.toContain('script');
    expect(secondRun).not.toContain('storyboard');
    // The failed stage and everything after it does run.
    expect(secondRun).toContain('synthesize');
    expect(secondRun).toContain('render');
    expect(secondRun[0]).toBe('synthesize');
  });

  it('records every completed stage in the one checkpoint document', async () => {
    const ran: string[] = [];
    const pipeline = new GenerationPipeline(STAGE_ORDER.map((n) => recordingStage(n, ran)), silentHooks);
    const ctx = buildContext(root, job);

    await pipeline.run(ctx, { seed: true });

    expect(await ctx.workspace.has(job.id, CHECKPOINT_KEY)).toBe(true);
    const saved = JSON.parse((await ctx.workspace.get(job.id, CHECKPOINT_KEY)).toString('utf8'));
    expect(saved.completed).toEqual([...STAGE_ORDER]);
  });

  it('lets a domain error through untouched rather than relabelling it', async () => {
    const ran: string[] = [];
    const pipeline = new GenerationPipeline(
      STAGE_ORDER.map((n) => recordingStage(n, ran, n === 'consolidate'
        ? () => { throw new InsufficientContentError(50, 400); }
        : undefined)),
      silentHooks,
    );

    await expect(pipeline.run(buildContext(root, job), {})).rejects.toBeInstanceOf(InsufficientContentError);
  });

  it('wraps an unexpected error as GENERATION_FAILED tagged with its stage', async () => {
    const ran: string[] = [];
    const pipeline = new GenerationPipeline(
      STAGE_ORDER.map((n) => recordingStage(n, ran, n === 'render'
        ? () => { throw new TypeError('ffmpeg exploded'); }
        : undefined)),
      silentHooks,
    );

    await expect(pipeline.run(buildContext(root, job), {}))
      .rejects.toMatchObject({ code: 'GENERATION_FAILED', details: { stage: 'render' } });
  });

  it('reports progress that reaches exactly 100', async () => {
    const seen: number[] = [];
    const ran: string[] = [];
    const pipeline = new GenerationPipeline(
      STAGE_ORDER.map((n) => recordingStage(n, ran)),
      (_stage, progress) => { seen.push(progress.percent); },
    );

    await pipeline.run(buildContext(root, job), {});

    expect(seen.at(-1)).toBe(100);
    // Monotonic, or the caller sees progress go backwards mid-job.
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });

  it('stops at a cancellation boundary', async () => {
    const ran: string[] = [];
    const ctx = buildContext(root, job);
    let calls = 0;
    const cancelling: PipelineContext = {
      ...ctx,
      throwIfCancelled: () => {
        calls += 1;
        if (calls > 3) throw new GenerationFailedError('cancelled', 'validate');
      },
    };

    const pipeline = new GenerationPipeline(STAGE_ORDER.map((n) => recordingStage(n, ran)), silentHooks);
    await expect(pipeline.run(cancelling, {})).rejects.toThrow();
    expect(ran.length).toBeLessThan(STAGE_ORDER.length);
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
});

describe('cancellation is not a failure', () => {
  it('passes JobCancelledError through the wrapper untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scgen-cancel-'));
    const job = VideoJob.create({
      outputLanguage: Language.of('en'), voiceSlot: 'en_female_1',
      qualityPreset: preset, style,
      features: JobFeatures.of({ images: true, imageSources: ['wikimedia'], planReview: true }),
      now: new Date(),
    });

    const ran: string[] = [];
    const pipeline = new GenerationPipeline(
      STAGE_ORDER.map((n) => recordingStage(n, ran, n === 'render'
        ? () => { throw new JobCancelledError(job.id.value); }
        : undefined)),
      silentHooks,
    );

    // Relabelling this as GENERATION_FAILED would report a job the caller
    // deliberately stopped as one that broke.
    await expect(pipeline.run(buildContext(root, job), {}))
      .rejects.toBeInstanceOf(JobCancelledError);

    await rm(root, { recursive: true, force: true });
  });
});

describe('cost ceiling circuit breaker', () => {
  it('fails the job at a stage boundary once the ceiling is breached', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scgen-ceiling-'));
    const job = VideoJob.create({
      outputLanguage: Language.of('en'), voiceSlot: 'en_female_1',
      qualityPreset: preset, style,
      features: JobFeatures.of({ images: true, imageSources: ['wikimedia'], planReview: true }),
      now: new Date(),
    });

    // A ceiling low enough that the first stage's own spend breaches it.
    const ctx = buildContext(root, job, 0.01);
    const ran: string[] = [];
    const pipeline = new GenerationPipeline(
      STAGE_ORDER.map((n) => recordingStage(n, ran, n === 'validate'
        ? undefined
        : undefined)),
      silentHooks,
    );

    // Spend past the ceiling during the first stage.
    ctx.costMeter.recordCustom('validate', 'llm', Money.fromUsd(5), {});

    await expect(pipeline.run(ctx, {})).rejects.toMatchObject({
      code: 'GENERATION_FAILED',
      details: expect.objectContaining({ ceiling_usd: 0.01 }),
    });

    // It stops rather than finishing an already-overspent job.
    expect(ran.length).toBeLessThan(STAGE_ORDER.length);
    await rm(root, { recursive: true, force: true });
  });

  it('does not interfere with a job inside its ceiling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scgen-ceiling-ok-'));
    const job = VideoJob.create({
      outputLanguage: Language.of('en'), voiceSlot: 'en_female_1',
      qualityPreset: preset, style,
      features: JobFeatures.of({ images: true, imageSources: ['wikimedia'], planReview: true }),
      now: new Date(),
    });

    const ran: string[] = [];
    const pipeline = new GenerationPipeline(STAGE_ORDER.map((n) => recordingStage(n, ran)), silentHooks);
    await expect(pipeline.run(buildContext(root, job, 2.0), {})).resolves.toBeDefined();
    expect(ran).toEqual([...STAGE_ORDER]);

    await rm(root, { recursive: true, force: true });
  });
});
