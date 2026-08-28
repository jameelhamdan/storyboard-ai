import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import type { ScriptGeneratorPort } from '../../port/ScriptGeneratorPort.js';
import type { VisualPlannerPort } from '../../port/VisualPlannerPort.js';
import { VisualPlan } from '@domain/media/VisualPlan.js';
import type { NarrationScript } from '@domain/script/NarrationScript.js';
import type { ConsolidatedSources, ScriptedContent } from './types.js';
import type { ScriptAssembler } from './ScriptAssembler.js';

export type { TextNormalizerPort } from './ScriptAssembler.js';

/**
 * StudentContext is applied here and only here (FR-14), via PersonalisationPolicy.
 *
 * Normalisation runs at the *end* of this stage, so everything downstream — the
 * storyboard LLM, the `data-on` anchors, the synthesiser — sees one identical
 * spoken form. The written form is kept on the Scene for subtitles.
 *
 * The visual plan is settled here too, in the same stage: scenes are written
 * independently and in parallel, and without a shared plan each one invents its
 * own palette — ten uncorrelated choices read as a ransom note rather than a
 * design. It needs the finished script and nothing else, so it has no reason to
 * be a stage of its own. A planning failure is never fatal: the theme's own
 * colours are a perfectly good design, so losing the plan costs coherence, not
 * the video.
 */
export class GenerateScriptStage implements PipelineStage<ConsolidatedSources, ScriptedContent> {
  public readonly name: StageName = 'script';

  constructor(
    private readonly generator: ScriptGeneratorPort,
    private readonly assembler: ScriptAssembler,
    private readonly planner: VisualPlannerPort,
  ) {}

  public async execute({ content }: ConsolidatedSources, ctx: PipelineContext): Promise<ScriptedContent> {
    const { duration, personalisation } = ctx.config.policies;
    const language = ctx.job.outputLanguage;

    const brief = personalisation.resolve(ctx.job.studentContext, ctx.job.style, ctx.job.direction);
    const target = duration.targetFor(content.stats, ctx.job.targetDuration);
    const wordBudget = duration.wordBudgetFor(target, language.code);

    ctx.logger.info({
      targetSeconds: target.seconds, wordBudget, register: brief.register.slice(0, 40),
    }, 'narration brief resolved');

    const result = await this.generator.generate({
      content,
      outputLanguage: language,
      targetDuration: target,
      wordBudget,
      brief,
      // Withdrawn at its source: a model that picks `illustration` on a
      // deployment with no image library costs a scene and a fallback board.
      imageSources: ctx.job.features.imageSources,
      signal: ctx.signal,
    });
    ctx.costMeter.recordTokens(this.name, result.usage);

    const script = this.assembler.assemble({
      result, language, brief, stage: this.name, ctx,
    });
    return { content, script, visualPlan: await this.planVisuals(script, ctx) };
  }

  private async planVisuals(script: NarrationScript, ctx: PipelineContext): Promise<VisualPlan> {
    try {
      const result = await this.planner.plan({
        script,
        outputLanguage: ctx.job.outputLanguage,
        // The first scene's title is the closest thing to a subject line the
        // pipeline has, and the palette should suit the material.
        subject: script.scenes[0]?.writtenText.slice(0, 200) ?? '',
        styleNote: ctx.job.style.visual,
        ...(ctx.job.direction ? { direction: ctx.job.direction.text } : {}),
        signal: ctx.signal,
      });
      ctx.costMeter.recordTokens(this.name, result.usage);

      ctx.logger.info({
        accents: result.plan.palette.accents.length,
        scenesPlanned: result.plan.scenes.length,
      }, 'visual plan resolved');
      return result.plan;
    } catch (error) {
      ctx.logger.warn({ err: error }, 'visual planning failed; falling back to the theme palette');
      const { tokens } = ctx.config.defaultTheme;
      return VisualPlan.default({
        ground: tokens.board.background,
        ink: tokens.ink.primary,
        accents: [tokens.ink.accent],
        muted: tokens.ink.muted,
      });
    }
  }

}
