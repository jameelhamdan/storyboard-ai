import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import type { TokenUsage } from '../../port/CostMeterPort.js';
import type { QuizQuestion } from '@domain/quiz/QuizQuestion.js';
import type { Storyboard } from '@domain/script/Storyboard.js';
import type { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import type { Language } from '@domain/shared/Language.js';
import type { SubtitledVideo, QuizzedVideo } from './types.js';

export interface QuizGeneratorPort {
  generate(input: {
    storyboard: Storyboard;
    content: ConsolidatedContent;
    language: Language;
    signal?: AbortSignal;
  }): Promise<{ questions: readonly QuizQuestion[]; usage: TokenUsage }>;
}

/**
 * Generated from the *timed* script after alignment, so source_moment_seconds is
 * exact rather than estimated — FR-15 requires the timestamp to point at the
 * moment the concept actually appears.
 */
export class GenerateQuizStage implements PipelineStage<SubtitledVideo, QuizzedVideo> {
  public readonly name: StageName = 'quiz';

  constructor(private readonly generator: QuizGeneratorPort) {}

  public async execute(input: SubtitledVideo, ctx: PipelineContext): Promise<QuizzedVideo> {
    const result = await this.generator.generate({
      storyboard: input.storyboard,
      content: input.content,
      language: ctx.job.outputLanguage,
      signal: ctx.signal,
    });
    ctx.costMeter.recordTokens(this.name, result.usage);

    // FR-15 wants 3-7. Over-generation is trimmed rather than failing a finished
    // video; under-generation is logged and passed through, since a short quiz is
    // still useful and the alternative is discarding the whole job.
    const questions = result.questions.slice(0, 7);
    if (questions.length < 3) {
      ctx.logger.warn({ count: questions.length }, 'quiz generator returned fewer than three questions');
    }

    return { ...input, quiz: questions };
  }
}
