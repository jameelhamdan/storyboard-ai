import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import type { VideoEncoderPort } from '../../port/VideoEncoderPort.js';
import type { WordTiming } from '@domain/media/WordTiming.js';
import { alignWrittenToSpoken } from '@domain/media/alignWrittenToSpoken.js';
import type { Duration } from '@domain/shared/Duration.js';
import type { SynthesizedAudio, SubtitledVideo } from './types.js';

/**
 * Cues are built from spoken-form word timings but display the written form —
 * a viewer reads "50%" while the timing came from "fifty percent".
 *
 * The mapping is positional: normalisation is word-preserving per token except
 * where it expands one written token into several spoken ones, so the written
 * text is re-flowed across the spoken timings proportionally. Where the two
 * forms are identical — the common case — this is an exact passthrough.
 */
export class GenerateSubtitlesStage implements PipelineStage<SynthesizedAudio, SubtitledVideo> {
  public readonly name: StageName = 'subtitles';

  constructor(private readonly encoder: VideoEncoderPort) {}

  public async execute(input: SynthesizedAudio, ctx: PipelineContext): Promise<SubtitledVideo> {
    const policy = ctx.config.policies.subtitles;
    const cues = [];
    let index = 1;

    for (const scene of input.storyboard.scenes) {
      const window = input.storyboard.windowFor(scene.index);
      if (!window) continue;

      const absolute = scene.wordTimings.map((t) => t.shiftedBy(window.start));
      const display = this.reflow(scene.writtenText, absolute, window.start, scene.duration);

      const sceneCues = policy.segment(display, index);
      cues.push(...sceneCues);
      index += sceneCues.length;
    }

    const drift = policy.maxDriftMs(
      cues,
      input.storyboard.scenes.flatMap((s) => {
        const w = input.storyboard.windowFor(s.index);
        return w ? s.wordTimings.map((t) => t.shiftedBy(w.start)) : [];
      }),
    );
    if (drift > ctx.config.subtitleMaxDriftMs) {
      // FR-8 is a hard requirement, so this is loud — but the cues are still
      // written, because a slightly-off subtitle beats no subtitle.
      ctx.logger.warn({ driftMs: drift, toleranceMs: ctx.config.subtitleMaxDriftMs }, 'subtitle drift over tolerance');
    }

    const scratch = await ctx.workspace.scratchPath(ctx.job.id, '11-subtitles/subtitles.srt');
    const written = await this.encoder.writeSubtitles(cues, scratch);
    const subtitleKey = '11-subtitles/subtitles.srt';
    await ctx.workspace.putFile(ctx.job.id, subtitleKey, written);

    ctx.logger.info({ cues: cues.length, maxDriftMs: drift }, 'subtitles generated');
    return { ...input, cues, subtitleKey };
  }

  /**
   * Re-keys the written form onto the spoken timings. See
   * `alignWrittenToSpoken` for why this is an alignment rather than a
   * proportional spread.
   */
  private reflow(
    writtenText: string,
    spoken: readonly WordTiming[],
    start: Duration,
    duration: Duration,
  ): WordTiming[] {
    return alignWrittenToSpoken(writtenText.split(/\s+/).filter(Boolean), spoken, start, duration);
  }
}
