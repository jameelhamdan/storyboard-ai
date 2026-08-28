import type { PipelineContext } from '../PipelineContext.js';
import type { AssembledVideo } from './types.js';

/**
 * A per-scene record of how the video was made, kept for inspection.
 *
 * The pipeline already writes almost all of this — previews under `06-previews`,
 * narration audio under its own prefix, frames, the checkpoint — but it is
 * organised by *stage*, which is the right layout for a pipeline and the wrong
 * one for a person. Asked why scene four looks the way it does, you want scene
 * four's board, its picture, its screenshot and its audio together, not four
 * prefixes and a naming convention.
 *
 * So this reorganises what is already there into `13-run/scene-000/…` plus an
 * index, and — the part that actually matters — the workspace is *not* reclaimed
 * afterwards. That is the whole cost of the feature and the reason it is off by
 * default: a kept run is a job's full working set left on the shared volume,
 * which the orphan sweeper would otherwise have taken.
 */
export class RunArtifacts {
  constructor(private readonly enabled: boolean) {}

  public get keepsWorkspace(): boolean {
    return this.enabled;
  }

  public async write(input: AssembledVideo, ctx: PipelineContext): Promise<void> {
    if (!this.enabled) return;

    const scenes = input.script.scenes;

    for (const scene of scenes) {
      const folder = `13-run/scene-${String(scene.index).padStart(3, '0')}`;

      // The board as it was rendered. Everything else about a scene can be
      // inferred from it — which shape, which picture, which anchors.
      if (scene.html) {
        await ctx.workspace.put(ctx.job.id, `${folder}/board.html`, Buffer.from(scene.html, 'utf8'));
      }

      await ctx.workspace.put(
        ctx.job.id,
        `${folder}/scene.json`,
        Buffer.from(JSON.stringify({
          index: scene.index,
          visual_intent: scene.visualIntent,
          used_fallback_component: scene.usedFallbackComponent,
          spoken: scene.spokenText,
          written: scene.writtenText,
          duration_seconds: scene.duration.seconds,
          citations: scene.citations.map((citation) => citation.id),
        }, null, 2), 'utf8'),
      );
    }

    /**
     * The index is what makes the folder navigable rather than archaeological:
     * one file naming every scene, the previews that exist for it, and the run's
     * own shape.
     */
    await ctx.workspace.put(
      ctx.job.id,
      '13-run/run.json',
      Buffer.from(JSON.stringify({
        job_id: ctx.job.id.value,
        language: ctx.job.outputLanguage.code,
        style: ctx.job.style.name,
        features: ctx.job.features.toJson(),
        scenes: scenes.length,
        previews: await ctx.workspace.list(ctx.job.id, '06-previews/'),
        scene_folders: scenes.map((scene) => `13-run/scene-${String(scene.index).padStart(3, '0')}`),
      }, null, 2), 'utf8'),
    );

    ctx.logger.info(
      { scenes: scenes.length, prefix: '13-run/' },
      'run artifacts kept; this job\'s workspace will not be reclaimed',
    );
  }
}
