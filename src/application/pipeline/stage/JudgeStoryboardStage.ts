import { join } from 'node:path';
import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import type { QualityJudgePort } from '../../port/QualityJudgePort.js';
import type { StoryboardGeneratorPort } from '../../port/StoryboardGeneratorPort.js';
import { SceneTimeline, type TimelineAnchor } from '@domain/script/SceneTimeline.js';
import type { Scene } from '@domain/script/Scene.js';
import { QualityVerdict, type SceneVerdict } from '@domain/quality/QualityVerdict.js';
import type { GateResult, HolisticScore } from '@domain/quality/QualityScore.js';
import { GenerationFailedError } from '@domain/error/GenerationFailedError.js';
import { inBatches } from '../inBatches.js';
import type { StoryboardedContent, JudgedStoryboard } from './types.js';
import type { BoardPreviewPort, BoardPreview } from '../../port/ScenePreviewPort.js';
import { Board, groupIntoBoards } from '@domain/script/Board.js';
import { Duration } from '@domain/shared/Duration.js';

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

/**
 * One board's outcome, with everything the stage needs to summarise it.
 *
 * A board is judged as a unit and therefore succeeds or fails as one: its
 * scenes share a diagram, so there is no such thing as the third scene's board
 * being wrong while the second's is right. The per-scene verdicts below are the
 * board's verdict recorded against each scene it covers, which is what keeps
 * the status payload's `scenes_*` counts meaningful.
 */
interface BoardOutcome {
  readonly scenes: readonly Scene[];
  readonly verdicts: readonly SceneVerdict[];
  readonly regenerated: number;
  readonly usedFallback: boolean;
  readonly deterministicFailures: readonly string[];
}

/** An attempt worth keeping, so a later worse one cannot silently replace it. */
interface Candidate {
  readonly board: Board;
  readonly gates: readonly GateResult[];
  readonly holistic: HolisticScore | undefined;
  readonly failedCount: number;
  readonly attempt: number;
}

/**
 * Sits *before* the expensive render, so a bad board costs one regeneration
 * rather than a wasted 18,000-frame render. Stage A first because it is free;
 * Stage B only on what survives it.
 *
 * **One vision call per board, not per scene.** This is the largest single line
 * in a run's bill — $0.177 of the $0.390 in `out/20260828-152720-heart`, which
 * is 45% of the video — and most of what it was buying was repetition: the
 * 4.5KB rubric, the source excerpt and the gate definitions were re-sent for
 * every scene, and a board narrated over three scenes paid for all of it three
 * times to review one diagram. A board is the honest unit anyway. Its scenes
 * share a picture, so "is this board grounded, does it read well" is one
 * question with one answer, and the judge is shown the build as a sequence of
 * frames rather than asked the same question about three views of it.
 *
 * **Boards are judged concurrently.** They used to run one after another, and
 * the reason was not the judging — it was a stage-level fallback counter that
 * every scene read and wrote, which would have made "which scene tripped the
 * limit" depend on timing. That budget is now checked once at the end, over the
 * finished set, so the loop has no shared state left and the cap is just a cap.
 * This stage was 399 of 501 seconds in `out/20260827-202226-battery`.
 *
 * **The best attempt ships.** See `judgeBoard`.
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
    private readonly previewer?: BoardPreviewPort,
  ) {}

  public async execute(input: StoryboardedContent, ctx: PipelineContext): Promise<JudgedStoryboard> {
    const boards = groupIntoBoards(
      input.script.scenes,
      Duration.fromMs(ctx.config.audio.interSceneGapMs),
    );

    const outcomes = await inBatches(
      boards,
      ctx.config.concurrency.judge,
      ctx,
      this.name,
      (batch) => Promise.all(batch.map((board) => this.judgeBoard(board, input, ctx))),
    );

    // Restored to script order: batches complete out of order, and scene order
    // is the video.
    const scenes = outcomes
      .flatMap((o) => o.scenes)
      .sort((a, b) => a.index - b.index);
    const verdicts = outcomes
      .flatMap((o) => o.verdicts)
      .sort((a, b) => a.sceneIndex - b.sceneIndex);

    /**
     * Counted in scenes, not boards.
     *
     * The budget and the status payload are both stated in scenes, and a board
     * that fell back took all of its scenes down with it — reporting one would
     * understate the damage by however many scenes the board covered.
     */
    const fallbackScenes = outcomes.filter((o) => o.usedFallback).flatMap((o) => o.scenes);

    const overBudget = ctx.config.policies.retryBudget.exceedsFallbackBudget(fallbackScenes.length);
    if (overBudget) {
      throw new GenerationFailedError(overBudget, this.name, {
        scenes_fallback: fallbackScenes.length,
        scene_indexes: fallbackScenes.map((s) => s.index),
      });
    }

    return {
      ...input,
      script: input.script.withScenes(scenes),
      storyboard: input.storyboard.withScenes(scenes),
      // Assembled here rather than downstream: this is the only stage that knows
      // what was retried, what fell back and what the gates said.
      verdict: QualityVerdict.of({
        scenes: verdicts,
        scenesRegenerated: outcomes.reduce((sum, o) => sum + o.regenerated * o.scenes.length, 0),
        scenesFallback: fallbackScenes.length,
        scenesBuiltInLayout: scenes.filter((scene) => scene.usedFallbackComponent).length,
        deterministicFailures: outcomes.flatMap((o) => o.deterministicFailures),
      }),
    };
  }

  /**
   * Judge one board, retry it while that is worth doing, and ship the best
   * attempt it produced.
   *
   * An earlier version overwrote the scene on every retry, so attempt N-1 was
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
  private async judgeBoard(
    original: Board,
    input: StoryboardedContent,
    ctx: PipelineContext,
  ): Promise<BoardOutcome> {
    const { judgeThreshold, retryBudget } = ctx.config.policies;

    let board = original;
    let attempt = 0;
    let regenerated = 0;
    let best: Candidate | undefined;
    const deterministicFailures: string[] = [];

    for (;;) {
      ctx.throwIfCancelled();

      /**
       * Stage A over every scene on the board.
       *
       * They share one document, so these checks mostly return the same answer
       * N times — but the markup is checked per scene because that is the unit
       * the checker reports against, and a board whose scenes somehow disagree
       * about their html is exactly the corruption worth catching here.
       */
      const stageA = await this.checks.check({
        scenes: board.scenes,
        minFontRem: ctx.config.defaultTheme.tokens.type.minRem,
        minContrastRatio: ctx.config.legibility.minContrastRatio,
        signal: ctx.signal,
      });
      const aFailures = stageA.flatMap((result) =>
        result.failures.map((failure) => `scene ${result.sceneIndex}: ${failure}`));
      deterministicFailures.push(...aFailures);

      // Photographed only when the free checks passed — there is no point
      // photographing markup already known to be malformed. The preview also
      // measures the laid-out page, so overlap, clipping and undersized text are
      // answered here rather than asked of a vision model.
      const preview = aFailures.length === 0
        ? await this.preview(board, input, ctx, attempt)
        : { paths: [] as readonly string[], layoutFailures: [] as readonly string[] };

      const layout = preview.layoutFailures.map((f) => `board ${board.index}: ${f}`);
      deterministicFailures.push(...layout);

      const structural = [...aFailures, ...layout];

      /**
       * One judge call for the whole board, carrying one frame per step.
       *
       * A board that is measurably broken is not sent at all. That is the older
       * saving and it still holds: a board with a collision in it is going to be
       * regenerated whatever the model thinks of its wording.
       */
      const plannedConcept = input.visualPlan.forScene(board.firstScene.index)?.concept;
      const judgement = structural.length === 0
        ? await this.judge.judgeBoard({
            board,
            content: input.content,
            screenshotPaths: preview.paths.length > 0
              ? preview.paths
              : stageA.flatMap((result) => result.screenshotPaths),
            ...(plannedConcept ? { plannedConcept } : {}),
            signal: ctx.signal,
          })
        : undefined;

      if (judgement) ctx.costMeter.recordTokens(this.name, judgement.usage);

      const gateVerdict = judgement
        ? judgeThreshold.evaluate(judgement.gates)
        : { passed: false, failedGates: [] as const };

      if (structural.length === 0 && gateVerdict.passed) {
        return this.outcome(board, judgement?.gates ?? [], judgement?.holistic, attempt, regenerated, false, deterministicFailures);
      }

      // A board that failed a deterministic check is malformed, not merely
      // imperfect, so it is never a candidate to ship. One a judge could read is,
      // however badly it scored.
      if (structural.length === 0 && judgement) {
        const candidate: Candidate = {
          board,
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
            sceneIndexes: original.sceneIndexes,
            reason: decision.reason,
            shippedAttempt: best.attempt,
            failedGates: best.gates.filter((g) => !g.passed).map((g) => g.gate),
          }, 'board shipped its best attempt rather than a fallback board');

          return this.outcome(best.board, best.gates, best.holistic, best.attempt, regenerated, false, deterministicFailures);
        }

        /**
         * Nothing renderable was ever produced.
         *
         * The board dissolves here: each scene gets its own synthetic `focus`
         * board stating its opening sentence. That is deliberate — there is no
         * shared diagram left to build on, and `asFallbackComponent` clears the
         * continuation flag so the regrouping downstream agrees.
         */
        ctx.logger.warn({
          sceneIndexes: original.sceneIndexes,
          reason: decision.reason,
          ...(deterministicFailures.length > 0 ? { structuralFailures: deterministicFailures } : {}),
        }, 'no attempt was renderable; board fell back to per-scene built-in boards');

        const scenes = original.scenes.map((scene) => {
          const fallback = this.generator.fallback(scene);
          return scene.asFallbackComponent(fallback.html, SceneTimeline.unresolved(fallback.anchors));
        });

        return {
          scenes,
          verdicts: scenes.map((scene) => ({
            sceneIndex: scene.index, gates: [], holistic: undefined, attempt,
          })),
          regenerated,
          usedFallback: true,
          deterministicFailures,
        };
      }

      // Targeted regeneration: the model is told which gate it failed, so it
      // fixes that rather than rerolling and hoping.
      const retry = await this.generator.regenerate({
        board,
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

      board = boardWith(board, retry.html, retry.anchors);
      attempt = decision.attempt;
      regenerated += 1;
    }
  }

  /** The board's single verdict, recorded against each scene it covers. */
  private outcome(
    board: Board,
    gates: readonly GateResult[],
    holistic: HolisticScore | undefined,
    attempt: number,
    regenerated: number,
    usedFallback: boolean,
    deterministicFailures: readonly string[],
  ): BoardOutcome {
    return {
      scenes: board.scenes,
      verdicts: board.scenes.map((scene) => ({
        sceneIndex: scene.index, gates, holistic, attempt,
      })),
      regenerated,
      usedFallback,
      deterministicFailures,
    };
  }

  /**
   * Screenshots go to the job workspace under the attempt number, so a
   * regenerated board does not overwrite the images its predecessor was judged
   * on — which is what makes a critique traceable after the fact. One file per
   * step, named for the scene that narrates it.
   */
  private async preview(
    board: Board,
    input: StoryboardedContent,
    ctx: PipelineContext,
    attempt: number,
  ): Promise<BoardPreview> {
    if (!this.previewer) return { paths: [], layoutFailures: [] };

    const root = await ctx.workspace.scratchPath(ctx.job.id, '06-previews');

    return this.previewer.capture({
      board,
      outputPathFor: (step) => {
        const scene = board.scenes[step - 1] ?? board.firstScene;
        return join(root, `scene-${String(scene.index).padStart(3, '0')}-a${attempt}.png`);
      },
      visualPlan: input.visualPlan,
      // The job's preset, not the configured default: judging a 1080p or
      // vertical board at 720p would review a frame nobody will ever see.
      width: ctx.job.qualityPreset.width,
      height: ctx.job.qualityPreset.height,
      minFontRem: ctx.config.defaultTheme.tokens.type.minRem,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  }
}

/**
 * The same board with a new attempt's markup on every scene.
 *
 * A board's scenes share one document, so a regenerated board has to replace it
 * on all of them — and each scene keeps only its own step's anchors, for the
 * same reason the storyboard stage splits them: a phrase resolves against the
 * timings of the scene that speaks it.
 */
function boardWith(board: Board, html: string, anchors: readonly TimelineAnchor[]): Board {
  const scenes = board.scenes.map((scene, i) => scene.withStoryboard(
    html,
    SceneTimeline.unresolved(anchors.filter((anchor) => (anchor.step ?? 1) === i + 1)),
  ));
  return Board.of(board.index, scenes, board.interSceneGap);
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
