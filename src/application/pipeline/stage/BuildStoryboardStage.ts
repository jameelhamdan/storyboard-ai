import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import { inBatches } from '../inBatches.js';
import type { StoryboardGeneratorPort } from '../../port/StoryboardGeneratorPort.js';
import { Storyboard } from '@domain/script/Storyboard.js';
import { SceneTimeline, type TimelineAnchor } from '@domain/script/SceneTimeline.js';
import { groupIntoBoards } from '@domain/script/Board.js';
import { Duration } from '@domain/shared/Duration.js';
import type { ScriptedContent, StoryboardedContent } from './types.js';

/**
 * Per **board**, the LLM describes one diagram and which step of the build each
 * element arrives in; `renderDiagram` lays it out. Bad output is a schema-
 * validation failure rather than an ugly video, which is the whole point of
 * constraining the vocabulary.
 *
 * A board spans the consecutive scenes the script marked as continuing it, so
 * this stage makes one call where it used to make one per scene. The board's
 * single document is then shared by every scene on it, and each scene keeps only
 * its own step's anchors — those phrases are verbatim from its narration and are
 * resolved against its own measured timings at synthesis.
 */
export class BuildStoryboardStage implements PipelineStage<ScriptedContent, StoryboardedContent> {
  public readonly name: StageName = 'storyboard';

  constructor(private readonly generator: StoryboardGeneratorPort) {}

  public async execute(input: ScriptedContent, ctx: PipelineContext): Promise<StoryboardedContent> {
    const scenes = input.script.scenes;
    const gap = Duration.fromMs(ctx.config.audio.interSceneGapMs);

    /**
     * Boards are grouped here, before anything is generated, because the board
     * is the unit the model is asked about. Grouping after the fact would mean
     * describing each scene alone and then pretending the results were one
     * diagram.
     */
    const boards = groupIntoBoards(scenes, gap);

    const results = await inBatches(
      boards, ctx.config.concurrency.storyboard, ctx, this.name,
      (batch) => this.generator.generate({
        boards: batch,
        visualPlan: input.visualPlan,
        ...(ctx.job.direction ? { direction: ctx.job.direction.text } : {}),
        imageSources: ctx.job.features.imageSources,
        signal: ctx.signal,
      }),
    );

    /** Keyed by every scene the board covers, since they all share its markup. */
    const generated = new Map<number, { html: string; anchors: readonly TimelineAnchor[]; usedFallback: boolean }>();
    for (const result of results) {
      ctx.costMeter.recordTokens(this.name, result.usage);
      for (const sceneIndex of result.sceneIndexes ?? [result.sceneIndex]) {
        generated.set(sceneIndex, {
          html: result.html,
          anchors: result.anchors,
          usedFallback: result.usedFallback === true,
        });
      }
    }

    /** Where a scene sits in its board, which is the step it owns. */
    const stepOf = new Map<number, number>();
    for (const board of boards) {
      board.scenes.forEach((scene, i) => stepOf.set(scene.index, i + 1));
    }

    const withHtml = scenes.map((scene) => {
      const result = generated.get(scene.index);
      if (!result) {
        // Missing rather than malformed: fall back now instead of failing the job.
        const fallback = this.generator.fallback(scene);
        return scene.asFallbackComponent(fallback.html, SceneTimeline.unresolved(fallback.anchors));
      }

      /**
       * Each scene takes only its own step's anchors.
       *
       * The board's markup is shared, but its anchors are not: a phrase belongs
       * to exactly one scene's narration, and `SceneTimeline.resolve` matches
       * against the timings of the scene it is attached to. Giving every scene
       * the whole board's anchors would have each one fail to match most of them
       * and fall back to inherited timing — the documented symptom of which is a
       * board that draws itself all at once.
       */
      const step = stepOf.get(scene.index) ?? 1;
      const mine = result.anchors.filter((anchor) => (anchor.step ?? 1) === step);
      const timeline = SceneTimeline.unresolved(mine);

      // A generator that substituted its own board is a fallback too —
      // marking it here is what makes it countable downstream.
      return result.usedFallback
        ? scene.asFallbackComponent(result.html, timeline)
        : scene.withStoryboard(result.html, timeline);
    });

    const fellBack = withHtml.filter((scene) => scene.usedFallbackComponent).length;
    if (fellBack > 0) {
      // Loud, because the rendered result looks like a deliberately plain scene
      // and nothing downstream would otherwise say the model produced nothing.
      ctx.logger.warn(
        { scenesFellBack: fellBack, of: withHtml.length },
        'scenes fell back to the built-in board at storyboard time',
      );
    }

    return {
      ...input,
      script: input.script.withScenes(withHtml),
      storyboard: Storyboard.of(withHtml, ctx.job.qualityPreset, gap),
    };
  }

}
