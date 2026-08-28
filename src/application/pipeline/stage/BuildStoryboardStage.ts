import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import { inBatches } from '../inBatches.js';
import type { StoryboardGeneratorPort } from '../../port/StoryboardGeneratorPort.js';
import { Storyboard } from '@domain/script/Storyboard.js';
import { SceneTimeline } from '@domain/script/SceneTimeline.js';
import { Duration } from '@domain/shared/Duration.js';
import type { ScriptedContent, StoryboardedContent } from './types.js';
/**
 * Per scene, the LLM emits HTML from the constrained component vocabulary plus a
 * declarative timeline — never CSS @keyframes, which cannot be seeked
 * deterministically. Bad output is a schema-validation failure rather than an
 * ugly video, which is the whole point of constraining the vocabulary.
 */
export class BuildStoryboardStage implements PipelineStage<ScriptedContent, StoryboardedContent> {
  public readonly name: StageName = 'storyboard';

  constructor(private readonly generator: StoryboardGeneratorPort) {}

  public async execute(input: ScriptedContent, ctx: PipelineContext): Promise<StoryboardedContent> {
    const scenes = input.script.scenes;
    const generated = new Map<number, { html: string; anchors: SceneTimeline; usedFallback: boolean }>();

    const results = await inBatches(
      scenes, ctx.config.concurrency.storyboard, ctx, this.name,
      (batch) => this.generator.generate({
        scenes: batch,
        visualPlan: input.visualPlan,
        ...(ctx.job.direction ? { direction: ctx.job.direction.text } : {}),
        imageSources: ctx.job.features.imageSources,
        signal: ctx.signal,
      }),
    );

    for (const result of results) {
      ctx.costMeter.recordTokens(this.name, result.usage);
      generated.set(result.sceneIndex, {
        html: result.html,
        anchors: SceneTimeline.unresolved(result.anchors),
        usedFallback: result.usedFallback === true,
      });
    }

    const withHtml = scenes.map((scene) => {
      const result = generated.get(scene.index);
      if (!result) {
        // Missing rather than malformed: fall back now instead of failing the job.
        const fallback = this.generator.fallback(scene);
        return scene.asFallbackComponent(fallback.html, SceneTimeline.unresolved(fallback.anchors));
      }
      // A generator that substituted its own board is a fallback too —
      // marking it here is what makes it countable downstream.
      return result.usedFallback
        ? scene.asFallbackComponent(result.html, result.anchors)
        : scene.withStoryboard(result.html, result.anchors);
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
      storyboard: Storyboard.of(
        withHtml,
        ctx.job.qualityPreset,
        Duration.fromMs(ctx.config.audio.interSceneGapMs),
      ),
    };
  }

}
