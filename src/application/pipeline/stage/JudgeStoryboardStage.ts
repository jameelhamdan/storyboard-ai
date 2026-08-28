import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import type { QualityJudgePort } from '../../port/QualityJudgePort.js';
import type { StoryboardGeneratorPort } from '../../port/StoryboardGeneratorPort.js';
import { SceneTimeline } from '@domain/script/SceneTimeline.js';
import type { Scene } from '@domain/script/Scene.js';
import { QualityVerdict, type SceneVerdict } from '@domain/quality/QualityVerdict.js';
import type { GateResult, HolisticScore } from '@domain/quality/QualityScore.js';
import { GenerationFailedError } from '@domain/error/GenerationFailedError.js';
import { inBatches } from '../inBatches.js';
import type { StoryboardedContent, JudgedStoryboard } from './types.js';
import type { ScenePreviewPort, ScenePreview } from '../../port/ScenePreviewPort.js';

export interface DeterministicCheckResult {
  readonly sceneIndex: number;
  readonly failures: readonly string[];
  readonly screenshotPaths: readonly string[];
}

/** Stage A: DOM and geometry checks in a headless page. No model, effectively free. */
export interface DeterministicSceneChecksPort {
  check(input: {
    scenes: readonly Scene[];
    minFontRem: number;
    minContrastRatio: number;
    signal?: AbortSignal;
  }): Promise<readonly DeterministicCheckResult[]>;
}

/** One scene's outcome, with everything the stage needs to summarise it. */
interface SceneOutcome {
  readonly scene: Scene;
  readonly verdict: SceneVerdict;
  readonly regenerated: number;
  readonly usedFallback: boolean;
  readonly deterministicFailures: readonly string[];
}

/** An attempt worth keeping, so a later worse one cannot silently replace it. */
interface Candidate {
  readonly scene: Scene;
  readonly gates: readonly GateResult[];
  readonly holistic: HolisticScore | undefined;
  readonly failedCount: number;
  readonly attempt: number;
}

/**
 * Sits *before* the expensive render, so a bad scene costs one regeneration
 * rather than a wasted 18,000-frame render. Stage A first because it is free;
 * Stage B only on what survives it.
 *
 * **Scenes are judged concurrently.** They used to run one after another, and
 * the reason was not the judging — it was a stage-level fallback counter that
 * every scene read and wrote, which would have made "which scene tripped the
 * limit" depend on timing. That budget is now checked once at the end, over the
 * finished set, so the loop has no shared state left and the cap is just a cap.
 * This stage was 399 of 501 seconds in `out/20260827-202226-battery`.
 *
 * **The best attempt ships.** See `judgeScene`.
 */
export class JudgeStoryboardStage implements PipelineStage<StoryboardedContent, JudgedStoryboard> {
  public readonly name: StageName = 'judgeStoryboard';

  constructor(
    private readonly checks: DeterministicSceneChecksPort,
    private readonly judge: QualityJudgePort,
    private readonly generator: StoryboardGeneratorPort,
    /**
     * Optional: without it the judge reads markup and guesses. With it, the
     * judge sees what a viewer would.
     */
    private readonly previewer?: ScenePreviewPort,
  ) {}

  public async execute(input: StoryboardedContent, ctx: PipelineContext): Promise<JudgedStoryboard> {
    const outcomes = await inBatches(
      input.script.scenes,
      ctx.config.concurrency.judge,
      ctx,
      this.name,
      (batch) => Promise.all(batch.map((scene) => this.judgeScene(scene, input, ctx))),
    );

    // Restored to script order: batches complete out of order, and scene order
    // is the video.
    const ordered = [...outcomes].sort((a, b) => a.scene.index - b.scene.index);
    const fallbacks = ordered.filter((o) => o.usedFallback).length;

    const overBudget = ctx.config.policies.retryBudget.exceedsFallbackBudget(fallbacks);
    if (overBudget) {
      throw new GenerationFailedError(overBudget, this.name, {
        scenes_fallback: fallbacks,
        scene_indexes: ordered.filter((o) => o.usedFallback).map((o) => o.scene.index),
      });
    }

    const scenes = ordered.map((o) => o.scene);

    return {
      ...input,
      script: input.script.withScenes(scenes),
      storyboard: input.storyboard.withScenes(scenes),
      // Assembled here rather than downstream: this is the only stage that knows
      // what was retried, what fell back and what the gates said.
      verdict: QualityVerdict.of({
        scenes: ordered.map((o) => o.verdict),
        scenesRegenerated: ordered.reduce((sum, o) => sum + o.regenerated, 0),
        scenesFallback: fallbacks,
        scenesBuiltInLayout: scenes.filter((scene) => scene.usedFallbackComponent).length,
        deterministicFailures: ordered.flatMap((o) => o.deterministicFailures),
      }),
    };
  }

  /**
   * Judge one scene, retry it while that is worth doing, and ship the best board
   * it produced.
   *
   * The previous version overwrote `scene` on every retry, so attempt N-1 was
   * destroyed the moment attempt N returned — even when N was worse — and on
   * exhaustion it threw all of them away for a synthetic board built by slicing
   * the narration into word windows. That board was never itself judged, and the
   * verdict recorded against the scene described the attempt that had just been
   * rejected. Two of five scenes in `out/20260827-202226-battery` shipped that
   * way, and the board they replaced was better than what replaced it.
   *
   * So: every judgeable attempt is a candidate, the best one ships, and the
   * synthetic board is reached only when nothing renderable was ever produced.
   */
  private async judgeScene(
    original: Scene,
    input: StoryboardedContent,
    ctx: PipelineContext,
  ): Promise<SceneOutcome> {
    const { judgeThreshold, retryBudget } = ctx.config.policies;

    let scene = original;
    let attempt = 0;
    let regenerated = 0;
    let best: Candidate | undefined;
    const deterministicFailures: string[] = [];

    for (;;) {
      ctx.throwIfCancelled();

      const [stageA] = await this.checks.check({
        scenes: [scene],
        minFontRem: ctx.config.defaultTheme.tokens.type.minRem,
        minContrastRatio: ctx.config.legibility.minContrastRatio,
        signal: ctx.signal,
      });
      const aFailures = stageA?.failures ?? [];
      if (aFailures.length > 0) {
        deterministicFailures.push(...aFailures.map((f) => `scene ${scene.index}: ${f}`));
      }

      // Rendered only for scenes that survived the free checks — there is no
      // point photographing markup already known to be malformed. The preview
      // also measures the laid-out page, so overlap, clipping and undersized
      // text are answered here rather than asked of a vision model.
      const preview = aFailures.length === 0
        ? await this.preview(scene, input, ctx, attempt)
        : { path: undefined, layoutFailures: [] as readonly string[] };

      const structural = [...aFailures, ...preview.layoutFailures];
      if (preview.layoutFailures.length > 0) {
        deterministicFailures.push(...preview.layoutFailures.map((f) => `scene ${scene.index}: ${f}`));
      }

      // A board that is measurably broken is not sent to the judge at all. That
      // is the saving: the vision call was 98% of the cost of
      // out/20260827-202226-battery, and a board with a collision in it is going
      // to be regenerated whatever the model thinks of its wording.
      const plannedConcept = input.visualPlan.forScene(scene.index)?.concept;
      const judgement = structural.length === 0
        ? await this.judge.judgeScene({
            scene,
            content: input.content,
            screenshotPaths: preview.path ? [preview.path] : (stageA?.screenshotPaths ?? []),
            ...(plannedConcept ? { plannedConcept } : {}),
            signal: ctx.signal,
          })
        : undefined;

      if (judgement) ctx.costMeter.recordTokens(this.name, judgement.usage);

      const gateVerdict = judgement
        ? judgeThreshold.evaluate(judgement.gates)
        : { passed: false, failedGates: [] as const };

      if (structural.length === 0 && gateVerdict.passed) {
        return {
          scene,
          verdict: { sceneIndex: scene.index, gates: judgement?.gates ?? [], holistic: judgement?.holistic, attempt },
          regenerated,
          usedFallback: false,
          deterministicFailures,
        };
      }

      // A board that failed a deterministic check is malformed, not merely
      // imperfect, so it is never a candidate to ship. One a judge could read is,
      // however badly it scored.
      if (structural.length === 0 && judgement) {
        const candidate: Candidate = {
          scene,
          gates: judgement.gates,
          holistic: judgement.holistic,
          failedCount: gateVerdict.failedGates.length,
          attempt,
        };
        if (!best || isBetter(candidate, best)) best = candidate;
      }

      const decision = retryBudget.decide({ attempt, failedGates: gateVerdict.failedGates });

      if (decision.action === 'stop') {
        if (best) {
          ctx.logger.warn({
            sceneIndex: original.index,
            reason: decision.reason,
            shippedAttempt: best.attempt,
            failedGates: best.gates.filter((g) => !g.passed).map((g) => g.gate),
          }, 'scene shipped its best attempt rather than a fallback board');

          return {
            scene: best.scene,
            verdict: { sceneIndex: original.index, gates: best.gates, holistic: best.holistic, attempt: best.attempt },
            regenerated,
            usedFallback: false,
            deterministicFailures,
          };
        }

        // Nothing renderable was ever produced. The synthetic board is a real
        // diagram — a `focus` stating the scene's opening sentence — rather than
        // fragments of the narration.
        const fallback = this.generator.fallback(original);
        ctx.logger.warn({
          sceneIndex: original.index,
          reason: decision.reason,
          ...(deterministicFailures.length > 0 ? { structuralFailures: deterministicFailures } : {}),
        }, 'no attempt was renderable; scene fell back to the built-in board');

        return {
          scene: original.asFallbackComponent(fallback.html, SceneTimeline.unresolved(fallback.anchors)),
          verdict: { sceneIndex: original.index, gates: [], holistic: undefined, attempt },
          regenerated,
          usedFallback: true,
          deterministicFailures,
        };
      }

      // Targeted regeneration: the model is told which gate it failed, so it
      // fixes that rather than rerolling and hoping.
      const retry = await this.generator.regenerate({
        scene,
        failedGates: gateVerdict.failedGates,
        // The judge's own words, not just the gate ids: "the arrow implies X,
        // which the narration does not say" is actionable; "G2 failed" is not.
        notes: [...structural, ...gateReasons(judgement)],
        visualPlan: input.visualPlan,
        ...(ctx.job.direction ? { direction: ctx.job.direction.text } : {}),
        imageSources: ctx.job.features.imageSources,
        signal: ctx.signal,
      });
      ctx.costMeter.recordTokens(this.name, retry.usage);
      if (retry.imagesGenerated) ctx.costMeter.recordImage(this.name, retry.imagesGenerated);
      scene = scene.withStoryboard(retry.html, SceneTimeline.unresolved(retry.anchors));
      attempt = decision.attempt;
      regenerated += 1;
    }
  }

  /**
   * Screenshots go to the job workspace under the attempt number, so a
   * regenerated scene does not overwrite the image its predecessor was judged
   * on — which is what makes a critique traceable after the fact.
   */
  private async preview(
    scene: Scene,
    input: StoryboardedContent,
    ctx: PipelineContext,
    attempt: number,
  ): Promise<ScenePreview> {
    if (!this.previewer) return { path: undefined, layoutFailures: [] };
    const key = `06-previews/scene-${String(scene.index).padStart(3, '0')}-a${attempt}.png`;
    const outputPath = await ctx.workspace.scratchPath(ctx.job.id, key);
    return this.previewer.capture({
      scene,
      outputPath,
      visualPlan: input.visualPlan,
      // The job's preset, not the configured default: judging a 1080p or
      // vertical scene at 720p would review a frame nobody will ever see.
      width: ctx.job.qualityPreset.width,
      height: ctx.job.qualityPreset.height,
      minFontRem: ctx.config.defaultTheme.tokens.type.minRem,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  }
}

/**
 * Fewer failed gates wins; the holistic score only breaks ties.
 *
 * That ordering is deliberate. The score is a model's opinion and drifts between
 * runs, which is why it does not gate anything — but between two boards that
 * failed the same number of gates it is the only signal available, and using it
 * there costs nothing.
 */
function isBetter(candidate: Candidate, incumbent: Candidate): boolean {
  if (candidate.failedCount !== incumbent.failedCount) {
    return candidate.failedCount < incumbent.failedCount;
  }
  return (candidate.holistic?.value ?? 0) > (incumbent.holistic?.value ?? 0);
}

/** The judge's per-gate explanations, which are what make a retry targeted. */
function gateReasons(judgement: { gates: readonly GateResult[] } | undefined): string[] {
  return (judgement?.gates ?? [])
    .filter((gate) => !gate.passed && gate.note)
    .map((gate) => `${gate.gate}: ${gate.note}`);
}
