import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import type { SceneRendererPort } from '../../port/SceneRendererPort.js';
import type { QuizzedVideo, RenderedVideo } from './types.js';
import { inBatches } from '../inBatches.js';

/**
 * Our own deterministic frame-capture loop: seek, screenshot, encode.
 *
 * A job's frame range splits across segments, each rendered and retried
 * independently — which is what makes render resumable per segment rather than
 * per job. Only the encoded segment is checkpointed; the frames behind it are
 * large, cheap to regenerate, and never worth persisting.
 */
export class RenderFramesStage implements PipelineStage<QuizzedVideo, RenderedVideo> {
  public readonly name: StageName = 'render';

  constructor(private readonly renderer: SceneRendererPort) {}

  public async execute(input: QuizzedVideo, ctx: PipelineContext): Promise<RenderedVideo> {
    const cap = ctx.config.concurrency.renderSegments;
    const segments = this.renderer.planSegments(input.storyboard, cap);

    ctx.logger.info({
      segments: segments.length,
      totalFrames: input.storyboard.totalFrames,
      preset: input.storyboard.preset.name,
    }, 'render planned');

    const rendered = await inBatches(segments, cap, ctx, this.name, (batch) =>
      Promise.all(batch.map(async (segment) => {
        const key = `09-segments/seg-${String(segment.index).padStart(3, '0')}.mp4`;

        // Per-segment resume: a worker that died halfway through does not redraw
        // the segments its predecessor already encoded.
        if (await ctx.workspace.has(ctx.job.id, key)) {
          ctx.logger.debug({ segment: segment.index }, 'segment already rendered — skipping');
          return { key, wallSeconds: 0 };
        }

        const outputPath = await ctx.workspace.scratchPath(ctx.job.id, key);
        const result = await this.renderer.renderSegment({
          storyboard: input.storyboard, segment, outputPath,
          visualPlan: input.visualPlan, signal: ctx.signal,
        });
        await ctx.workspace.putFile(ctx.job.id, key, result.path);
        return { key, wallSeconds: result.wallSeconds };
      })),
    );

    const wallSeconds = rendered.reduce((total, r) => total + r.wallSeconds, 0);
    ctx.costMeter.recordRender(this.name, wallSeconds);

    return {
      ...input,
      segmentKeys: rendered.map((r) => r.key).sort(),
      renderWallSeconds: wallSeconds,
    };
  }
}
