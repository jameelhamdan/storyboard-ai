import type { QuizGeneratorPort } from '@application/pipeline/stage/GenerateQuizStage.js';
import type { Storyboard } from '@domain/script/Storyboard.js';
import type { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import type { Language } from '@domain/shared/Language.js';
import type { TokenUsage } from '@application/port/CostMeterPort.js';
import { QuizQuestion } from '@domain/quiz/QuizQuestion.js';
import type { LlmClientPort } from '@application/port/LlmClientPort.js';
import type { PromptLibrary } from './PromptLibrary.js';
import { quizSchema } from './schemas.js';

interface QuizResponse {
  questions: { question: string; answer: string; sceneIndex: number }[];
}

/**
 * The model picks *which scene* each question comes from; the timestamp is then
 * computed from that scene's measured window. Asking a model for a number in
 * seconds would get a plausible-looking guess — FR-15 wants the moment the
 * concept actually appears, and only the storyboard knows that.
 */
export class PromptedQuizGenerator implements QuizGeneratorPort {
  constructor(
    private readonly client: LlmClientPort,
    private readonly prompts: PromptLibrary,
  ) {}

  public async generate(input: {
    storyboard: Storyboard;
    content: ConsolidatedContent;
    language: Language;
    signal?: AbortSignal;
  }): Promise<{ questions: readonly QuizQuestion[]; usage: TokenUsage }> {
    const prompt = this.prompts.render('04-quiz-generation', {
      output_language: input.language.code,
      script: input.storyboard.scenes
        .map((s) => `### Scene ${s.index}\n${s.writtenText}`)
        .join('\n\n'),
    });

    const result = await this.client.generate<QuizResponse>({
      system: prompt.system,
      user: prompt.user,
      tier: 'volume',
      responseSchema: quizSchema as unknown as Record<string, unknown>,
      /**
       * Three to seven questions, each a question, an answer and a timestamp.
       * 1200 is roughly double the largest quiz the policy permits, which leaves
       * room for a verbose model without leaving room for a runaway one.
       */
      maxOutputTokens: 1200,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const questions: QuizQuestion[] = [];

    for (const item of result.parsed?.questions ?? []) {
      const scene = input.storyboard.scenes.find((s) => s.index === item.sceneIndex);
      const window = input.storyboard.windowFor(item.sceneIndex);
      // A question pinned to a scene that does not exist has no moment to point
      // at, which is the one thing FR-15 requires of it.
      if (!scene || !window) continue;

      questions.push(QuizQuestion.of({
        question: item.question.trim(),
        answer: item.answer.trim(),
        sourceMomentSeconds: window.start.seconds,
        citations: scene.citations,
      }));
    }

    return { questions, usage: result.usage };
  }
}
