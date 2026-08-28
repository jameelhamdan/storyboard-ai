import { describe, it, expect } from 'vitest';
import { JobFeatures } from '@domain/job/JobFeatures.js';
import { VideoJob } from '@domain/job/VideoJob.js';
import { JobId } from '@domain/job/JobId.js';
import { canTransition, isTerminal } from '@domain/job/JobStatus.js';
import { Progress } from '@domain/job/Progress.js';
import { Duration } from '@domain/shared/Duration.js';
import { Money } from '@domain/shared/Money.js';
import { Language } from '@domain/shared/Language.js';
import { QualityPreset } from '@domain/media/QualityPreset.js';
import { VideoStyle } from '@domain/media/VideoStyle.js';
import { WordTiming, resolvePhrase } from '@domain/media/WordTiming.js';
import { Scene } from '@domain/script/Scene.js';
import { SceneTimeline } from '@domain/script/SceneTimeline.js';
import { Storyboard } from '@domain/script/Storyboard.js';
import { Citation } from '@domain/content/Citation.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { GenerationCost } from '@domain/cost/GenerationCost.js';
import { CostBreakdown } from '@domain/cost/CostBreakdown.js';

const preset = QualityPreset.of({ name: 'standard', width: 1280, height: 720, fps: 24, codec: 'h264', crf: 23 });
const style = VideoStyle.of({
  name: 'explainer', label: 'Explainer',
  narration: 'Warm and clear, addressed to one learner.',
  visual: 'One idea per board, room to breathe.',
});
const zeroCost = () => GenerationCost.of(CostBreakdown.empty(), 120);
const newJob = () => VideoJob.create({
  outputLanguage: Language.of('en'),
  voiceSlot: 'en_female_1',
  qualityPreset: preset,
  style,
  features: JobFeatures.of({ images: true, imageSources: ['wikimedia'], planReview: true }),
  now: new Date(),
});

describe('JobId', () => {
  it('generates UUIDv4 — the only thing protecting an unauthenticated /status', () => {
    expect(JobId.isValid(JobId.generate().value)).toBe(true);
  });

  it('rejects a non-UUID', () => {
    expect(() => JobId.of('123')).toThrow(RangeError);
    expect(JobId.isValid('not-a-uuid')).toBe(false);
  });
});

describe('VideoJob state machine', () => {
  it('starts queued at zero progress', () => {
    const job = newJob();
    expect(job.status).toBe('queued');
    expect(job.progress.percent).toBe(0);
  });

  it('counts attempts on each start, which is what bounds a poison job', () => {
    const job = newJob();
    job.start(new Date());
    expect(job.attempts).toBe(1);
    job.requeue(new Date());
    job.start(new Date());
    expect(job.attempts).toBe(2);
  });

  it('allows processing -> queued: the chaos-test requeue path', () => {
    expect(canTransition('processing', 'queued')).toBe(true);
  });

  it('refuses to resurrect a terminal job', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      expect(isTerminal(status)).toBe(true);
      expect(canTransition(status, 'processing')).toBe(false);
    }
  });

  it('throws rather than silently ignoring an illegal transition', () => {
    const job = newJob();
    job.start(new Date());
    job.cancel(new Date());
    expect(() => job.start(new Date())).toThrow(/Illegal job transition/);
  });

  it('keeps progress monotonic so a resumed job never appears to go backwards', () => {
    const job = newJob();
    job.start(new Date());
    job.advanceTo('render', Progress.of(60), new Date());
    job.advanceTo('render', Progress.of(30), new Date());
    expect(job.progress.percent).toBe(60);
  });

  it('refuses to advance a job that is not processing', () => {
    expect(() => newJob().advanceTo('render', Progress.of(10), new Date())).toThrow(/Cannot advance/);
  });

  it('round-trips through a snapshot', () => {
    const job = newJob();
    job.start(new Date());
    const restored = VideoJob.rehydrate({
      snapshot: job.toSnapshot(), qualityPreset: preset, style, direction: undefined,
      features: JobFeatures.of({ images: true, imageSources: ['wikimedia'], planReview: true }),
      studentContext: job.studentContext, cost: null, verdict: null, quiz: [],
    });
    expect(restored.id.value).toBe(job.id.value);
    expect(restored.status).toBe('processing');
    expect(restored.attempts).toBe(1);
  });
});

describe('Money — integer micros, because cost accumulates over ~70 calls', () => {
  it('does not drift over many small additions', () => {
    const cents = Array.from({ length: 100 }, () => Money.fromUsd(0.01));
    expect(Money.sum(cents).usd).toBe(1);
  });

  it('computes per-minute cost, the unit the brief caps', () => {
    expect(Money.fromUsd(0.30).perMinute(600).toUsdRounded(2)).toBe(0.03);
  });

  it('returns zero per-minute for a zero-length video rather than dividing by zero', () => {
    expect(Money.fromUsd(1).perMinute(0).usd).toBe(0);
  });

  it('refuses negative money', () => {
    expect(() => Money.fromUsd(-1)).toThrow(RangeError);
  });
});

describe('Duration', () => {
  it('formats SRT and ffmpeg timecodes', () => {
    const d = Duration.fromMs(3_723_456);
    expect(d.toTimecode(',')).toBe('01:02:03,456');
    expect(d.toTimecode('.')).toBe('01:02:03.456');
  });

  it('converts to frames at the preset fps', () => {
    expect(Duration.fromSeconds(1).toFrames(24)).toBe(24);
  });

  it('never goes negative on subtraction', () => {
    expect(Duration.fromMs(100).minus(Duration.fromMs(500)).ms).toBe(0);
  });
});

describe('QualityPreset', () => {
  it('rejects odd dimensions, which H.264 cannot encode', () => {
    expect(() => QualityPreset.of({ name: 'x', width: 1281, height: 720, fps: 24, codec: 'h264', crf: 23 }))
      .toThrow(/even dimensions/);
  });

  it('rejects an out-of-range CRF', () => {
    expect(() => QualityPreset.of({ name: 'x', width: 1280, height: 720, fps: 24, codec: 'h264', crf: 99 }))
      .toThrow(/CRF/);
  });

  it('reports 1440 frames per video-minute at 720p24', () => {
    expect(preset.framesPerVideoMinute).toBe(1440);
  });
});

describe('phrase anchoring — the sync mechanism', () => {
  const timings = [
    WordTiming.of('The', 0, 200), WordTiming.of('light', 200, 600),
    WordTiming.of('reactions', 600, 1200), WordTiming.of('produce', 1200, 1600),
    WordTiming.of('ATP.', 1600, 2000),
  ];

  it('resolves a multi-word phrase to its first word', () => {
    expect(resolvePhrase('light reactions', timings)?.ms).toBe(200);
  });

  it('is case-insensitive and punctuation-insensitive', () => {
    expect(resolvePhrase('LIGHT REACTIONS', timings)?.ms).toBe(200);
    expect(resolvePhrase('atp', timings)?.ms).toBe(1600);
  });

  it('returns undefined for a phrase that is not spoken', () => {
    expect(resolvePhrase('Calvin cycle', timings)).toBeUndefined();
  });

  it('takes the first occurrence when a phrase repeats', () => {
    const repeated = [...timings, WordTiming.of('light', 2000, 2400), WordTiming.of('reactions', 2400, 2800)];
    expect(resolvePhrase('light reactions', repeated)?.ms).toBe(200);
  });
});

describe('SceneTimeline fallback rules', () => {
  const timings = [
    WordTiming.of('alpha', 0, 500), WordTiming.of('beta', 500, 1000), WordTiming.of('gamma', 1000, 1500),
  ];

  it('reveals an unanchored element at scene start', () => {
    const resolved = SceneTimeline.unresolved([
      { elementId: 'a', phrase: undefined, draw: 'normal', hold: true },
    ]).resolve(timings);
    expect(resolved.reveals[0]!.at.ms).toBe(0);
  });

  it('inherits the previous time when a phrase does not match, and records it', () => {
    const resolved = SceneTimeline.unresolved([
      { elementId: 'a', phrase: 'beta', draw: 'normal', hold: true },
      { elementId: 'b', phrase: 'nonexistent', draw: 'normal', hold: true },
    ]).resolve(timings);

    expect(resolved.reveals.find((r) => r.elementId === 'b')!.at.ms).toBe(500);
    expect(resolved.reveals.find((r) => r.elementId === 'b')!.fallback).toBe(true);
    expect(resolved.unmatchedAnchors).toEqual(['nonexistent']);
  });

  it('orders reveals by resolved time, so the model cannot create an impossible sequence', () => {
    const resolved = SceneTimeline.unresolved([
      { elementId: 'late', phrase: 'gamma', draw: 'normal', hold: true },
      { elementId: 'early', phrase: 'alpha', draw: 'normal', hold: true },
    ]).resolve(timings);

    expect(resolved.reveals.map((r) => r.elementId)).toEqual(['early', 'late']);
  });
});

describe('Storyboard.retime — why render happens after synthesis', () => {
  const scene = (index: number, estimateMs: number) => Scene.of({
    index,
    spokenText: `narration for scene ${index}`,
    citations: [Citation.of(`c${index}`, [SourceRef.page('doc', index + 1)])],
    visualIntent: 'focus',
    estimatedDuration: Duration.fromMs(estimateMs),
  });

  it('lays scenes end to end with the configured inter-scene gap', () => {
    const board = Storyboard.of([scene(0, 1000), scene(1, 2000)], preset, Duration.fromMs(350));
    expect(board.windowFor(0)).toMatchObject({ start: Duration.fromMs(0) });
    expect(board.windowFor(1)!.start.ms).toBe(1350);
    expect(board.totalDuration.ms).toBe(3350);
  });

  it('rebuilds the timeline from measured audio, not the estimate', () => {
    const measured = scene(0, 1000).withMeasuredAudio(Duration.fromMs(4000), []);
    const board = Storyboard.of([measured, scene(1, 2000)], preset, Duration.fromMs(0));
    expect(board.windowFor(1)!.start.ms).toBe(4000);
  });

  it('reports frame counts consistent with the preset fps', () => {
    const board = Storyboard.of([scene(0, 1000)], preset, Duration.zero());
    expect(board.totalFrames).toBe(24);
  });
});

/**
 * "How long did this take" is a number the caller asks for, so it has to mean
 * wall-clock generation time — not time since the request was accepted, and not
 * time since the most recent attempt.
 */
describe('generation time', () => {
  it('is undefined until the job completes', () => {
    const job = newJob();
    expect(job.generationSeconds).toBeUndefined();
    job.start(new Date());
    expect(job.generationSeconds).toBeUndefined();
  });

  it('measures from the first start to completion', () => {
    const job = newJob();
    const t0 = new Date('2026-01-01T00:00:00Z');
    job.start(t0);
    job.complete({
      artifacts: { videoUrl: 'v', subtitleUrl: 's', traceabilityUrl: 't', costUrl: 'c', durationSeconds: 120 },
      cost: zeroCost(), verdict: null, quiz: [],
      now: new Date(t0.getTime() + 92_500),
    });
    expect(job.generationSeconds).toBe(92.5);
  });

  it('does not restart the clock when a dead worker\'s job is reclaimed', () => {
    const job = newJob();
    const t0 = new Date('2026-01-01T00:00:00Z');
    job.start(t0);
    job.requeue(new Date(t0.getTime() + 30_000));
    job.start(new Date(t0.getTime() + 60_000));
    job.complete({
      artifacts: { videoUrl: 'v', subtitleUrl: 's', traceabilityUrl: 't', costUrl: 'c', durationSeconds: 120 },
      cost: zeroCost(), verdict: null, quiz: [],
      now: new Date(t0.getTime() + 100_000),
    });
    // 100s from the first start, not 40s from the second.
    expect(job.generationSeconds).toBe(100);
  });

  it('survives the repository round-trip', () => {
    const job = newJob();
    const t0 = new Date('2026-01-01T00:00:00Z');
    job.start(t0);
    job.complete({
      artifacts: { videoUrl: 'v', subtitleUrl: 's', traceabilityUrl: 't', costUrl: 'c', durationSeconds: 120 },
      cost: zeroCost(), verdict: null, quiz: [],
      now: new Date(t0.getTime() + 45_000),
    });

    const wire = JSON.parse(JSON.stringify(job.toSnapshot()));
    const restored = VideoJob.rehydrate({
      snapshot: wire, qualityPreset: preset, style, direction: undefined,
      features: JobFeatures.of({ images: true, imageSources: ['wikimedia'], planReview: true }),
      studentContext: job.studentContext, cost: null, verdict: null, quiz: [],
    });
    expect(restored.generationSeconds).toBe(45);
    expect(restored.toSnapshot().generationSeconds).toBe(45);
  });
});

describe('cost and quality survive persistence', () => {
  it('a rehydrated completed job still reports cost and quality', async () => {
    const { GenerationCost } = await import('@domain/cost/GenerationCost.js');
    const { CostBreakdown } = await import('@domain/cost/CostBreakdown.js');
    const { QualityVerdict } = await import('@domain/quality/QualityVerdict.js');
    const { Money } = await import('@domain/shared/Money.js');

    const job = newJob();
    job.start(new Date());
    job.complete({
      artifacts: { videoUrl: 'v', subtitleUrl: 's', traceabilityUrl: 't', costUrl: 'https://x/cost.json', durationSeconds: 120 },
      cost: GenerationCost.of(
        CostBreakdown.empty().with({ stage: 'script', category: 'llm', provider: 'stub', amount: Money.fromUsd(0.05), units: { input_tokens: 100 } }),
        120,
      ),
      verdict: QualityVerdict.of({ scenes: [], scenesRegenerated: 2, scenesFallback: 1 }),
      quiz: [],
      now: new Date(),
    });

    // Round-trip exactly as the repository does: snapshot -> JSON -> rehydrate.
    const wire = JSON.parse(JSON.stringify(job.toSnapshot()));
    const restored = VideoJob.rehydrate({
      snapshot: wire, qualityPreset: preset, style, direction: undefined,
      features: JobFeatures.of({ images: true, imageSources: ['wikimedia'], planReview: true }),
      studentContext: job.studentContext, cost: null, verdict: null, quiz: [],
    });

    const snapshot = restored.toSnapshot();
    expect(snapshot.cost).toMatchObject({ total_usd: 0.05 });
    expect(snapshot.quality).toMatchObject({ scenes_regenerated: 2, scenes_fallback: 1 });
  });
});

/**
 * The invariant the Redis repository enforces atomically: two writers race by
 * design — the API cancels while a worker is mid-pipeline, and that worker then
 * persists progress from a copy that still says 'processing'.
 */
describe('terminal states are final', () => {
  it('a cancelled job cannot be advanced back to processing', () => {
    const job = newJob();
    job.start(new Date());
    job.cancel(new Date());

    expect(job.isTerminal).toBe(true);
    expect(() => job.advanceTo('render', Progress.of(50), new Date())).toThrow(/Cannot advance/);
    expect(() => job.start(new Date())).toThrow(/Illegal job transition/);
  });

  it('every terminal status refuses every onward transition', () => {
    for (const from of ['completed', 'failed', 'cancelled'] as const) {
      for (const to of ['queued', 'processing', 'completed', 'failed', 'cancelled'] as const) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });
});

/**
 * The chaos-test path, at the state-machine level.
 *
 * A worker that dies mid-job leaves the stored state on `processing` — nothing
 * moves it back, because the process that would have done so is gone. The
 * replacement must be able to reclaim it, which means `processing -> queued`
 * has to be a legal transition and a re-`start()` has to count as a new attempt.
 */
describe('reclaiming a job abandoned by a dead worker', () => {
  it('allows processing -> queued -> processing and counts the attempt', () => {
    const job = newJob();
    job.start(new Date());
    job.advanceTo('synthesize', Progress.of(59), new Date());
    expect(job.attempts).toBe(1);

    // Replacement worker reclaims it.
    job.requeue(new Date());
    expect(job.status).toBe('queued');
    job.start(new Date());

    expect(job.status).toBe('processing');
    expect(job.attempts).toBe(2);
    // Progress is retained, so the caller never sees the bar jump backwards.
    expect(job.progress.percent).toBe(59);
  });

  it('refuses a direct processing -> processing restart', () => {
    const job = newJob();
    job.start(new Date());
    expect(() => job.start(new Date())).toThrow(/Illegal job transition processing -> processing/);
  });
});
