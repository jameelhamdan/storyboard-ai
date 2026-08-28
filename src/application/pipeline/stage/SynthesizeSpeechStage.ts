import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import type { SpeechSynthesisPort } from '../../port/SpeechSynthesisPort.js';
import type { VideoEncoderPort } from '../../port/VideoEncoderPort.js';
import { Duration } from '@domain/shared/Duration.js';
import { GenerationFailedError } from '@domain/error/GenerationFailedError.js';
import type { JudgedStoryboard, SynthesizedAudio } from './types.js';
import { inBatches } from '../inBatches.js';

/**
 * Synthesize per scene and take word timings from the provider's own timestamp
 * API. These come from the synthesiser, so they are exact rather than inferred —
 * which is what makes FR-8's 100ms tolerance straightforward.
 *
 * Audio post-processing happens here too: concatenated raw TTS at inconsistent
 * levels sounds amateur regardless of how good the voice is.
 *
 * Re-timing is the last thing this stage does, and it is the actual
 * narration/visual sync mechanism: planned scene durations never match
 * synthesized audio, so the storyboard timeline is rebuilt from what was
 * measured. It is why rendering happens after synthesis rather than beside it.
 */
export class SynthesizeSpeechStage implements PipelineStage<JudgedStoryboard, SynthesizedAudio> {
  public readonly name: StageName = 'synthesize';

  constructor(
    private readonly speech: SpeechSynthesisPort,
    private readonly encoder: VideoEncoderPort,
  ) {}

  public async execute(input: JudgedStoryboard, ctx: PipelineContext): Promise<SynthesizedAudio> {
    const voice = ctx.config.voices.get(ctx.job.voiceSlot);
    if (!voice) {
      throw new GenerationFailedError(`Voice slot '${ctx.job.voiceSlot}' is not configured.`, this.name);
    }

    const scenes = input.script.scenes;
    const parts: { path: string; gapAfterMs: number }[] = [];
    const timed = [...scenes];

    const results = await inBatches(
      scenes, ctx.config.concurrency.speechSynthesis, ctx, this.name,
      (batch) => Promise.all(batch.map(async (scene) => {
        const outputPath = await ctx.workspace.scratchPath(ctx.job.id, `07-audio/scene-${scene.index}.wav`);
        const result = await this.speech.synthesize({
          text: scene.spokenText, voice, outputPath, signal: ctx.signal,
        });
        ctx.costMeter.recordTts(this.name, result.characterCount, result.durationMs / 1000);
        return { scene, result };
      })),
    );

    for (const { scene, result } of results) {
      const position = timed.findIndex((s) => s.index === scene.index);
      timed[position] = scene.withMeasuredAudio(Duration.fromMs(result.durationMs), result.wordTimings);
      parts.push({ path: result.audioPath, gapAfterMs: ctx.config.audio.interSceneGapMs });
    }

    // Trailing gap belongs between scenes, not after the last one.
    const last = parts.at(-1);
    if (last) parts[parts.length - 1] = { ...last, gapAfterMs: 0 };

    const mixPath = await ctx.workspace.scratchPath(ctx.job.id, '07-audio/narration.wav');
    const mixed = await this.encoder.concatAudio({
      parts,
      outputPath: mixPath,
      targetLufs: ctx.config.audio.loudnessTargetLufs,
      truePeakDb: ctx.config.audio.truePeakDb,
      signal: ctx.signal,
    });

    const audioKey = '07-audio/narration.wav';
    await ctx.workspace.putFile(ctx.job.id, audioKey, mixed.path);

    // Re-timed against measured audio, so text reveals land on the words that
    // speak them. Cheap — each Scene already absorbed its own measurement above.
    const storyboard = input.storyboard.withScenes(timed).retime();

    const unmatched = storyboard.scenes.reduce(
      (total, scene) => total + scene.timeline.unmatchedAnchors.length, 0,
    );
    if (unmatched > 0) {
      // Not fatal — the documented fallback inherits the previous element's time.
      // Stage A already failed any scene with more than one, so what reaches here
      // is within tolerance; it is logged because a rising count means the
      // normalizer and the storyboard prompt have drifted apart.
      ctx.logger.warn({ unmatchedAnchors: unmatched }, 'anchors fell back to inherited timing');
    }

    ctx.logger.info({
      totalSeconds: storyboard.totalDuration.seconds,
      totalFrames: storyboard.totalFrames,
    }, 'storyboard retimed against measured audio');

    return {
      ...input,
      script: input.script.withScenes(timed),
      storyboard,
      audioKey,
      totalAudioMs: mixed.durationMs,
    };
  }

}
