import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import type { VideoEncoderPort } from '../../port/VideoEncoderPort.js';
import type { RenderedVideo, AssembledVideo } from './types.js';

/**
 * ffmpeg concat + audio mux, encoded per the active quality preset.
 *
 * The subtitle track is muxed in here rather than in a second pass, because the
 * SRT already exists by this point — `subtitles` runs before `render` — and a
 * separate pass would mean re-encoding a finished video to add a few KB of text.
 */
export class AssembleVideoStage implements PipelineStage<RenderedVideo, AssembledVideo> {
  public readonly name: StageName = 'assemble';

  constructor(private readonly encoder: VideoEncoderPort) {}

  public async execute(input: RenderedVideo, ctx: PipelineContext): Promise<AssembledVideo> {
    // Materialise from the shared workspace: the assembling worker is not
    // necessarily the one that rendered these.
    const segmentPaths = await Promise.all(
      input.segmentKeys.map((key) => ctx.workspace.localCopy(ctx.job.id, key)),
    );
    const audioPath = await ctx.workspace.localCopy(ctx.job.id, input.audioKey);
    const outputPath = await ctx.workspace.scratchPath(ctx.job.id, '10-video/video.mp4');

    // Skipped when there are no cues: muxing an empty track would leave players
    // offering a subtitle option that displays nothing.
    const subtitles = input.cues.length > 0
      ? {
          path: await ctx.workspace.localCopy(ctx.job.id, input.subtitleKey),
          languageCode: ctx.job.outputLanguage.code,
        }
      : undefined;

    const result = await this.encoder.assemble({
      segmentPaths,
      audioPath,
      outputPath,
      preset: ctx.job.qualityPreset,
      ...(subtitles ? { subtitles } : {}),
      signal: ctx.signal,
    });

    const videoKey = '10-video/video.mp4';
    await ctx.workspace.putFile(ctx.job.id, videoKey, result.path);

    ctx.logger.info({
      durationSeconds: result.durationSeconds,
      sizeBytes: result.sizeBytes,
      preset: ctx.job.qualityPreset.name,
      subtitleTrack: subtitles ? ctx.job.outputLanguage.code : 'none',
    }, 'video assembled');

    return {
      ...input,
      videoKey,
      durationSeconds: result.durationSeconds,
      sizeBytes: result.sizeBytes,
    };
  }
}
