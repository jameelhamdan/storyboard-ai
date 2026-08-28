import type { QuizGeneratorPort } from '@application/pipeline/stage/GenerateQuizStage.js';
import type { Storyboard } from '@domain/script/Storyboard.js';
import { QuizQuestion } from '@domain/quiz/QuizQuestion.js';

/**
 * Builds questions from the *timed* storyboard, so `source_moment_seconds` is
 * genuinely exact — the FR-15 timestamp path is real even though the question
 * wording is mechanical.
 */
export class StubQuizGenerator implements QuizGeneratorPort {
  public async generate(input: { storyboard: Storyboard }): Promise<{
    questions: readonly QuizQuestion[];
    usage: { inputTokens: number; outputTokens: number; model: string };
  }> {
    const scenes = input.storyboard.scenes.slice(0, 5);

    const questions = scenes.map((scene) => {
      const window = input.storyboard.windowFor(scene.index);
      const subject = scene.writtenText.split(/\s+/).slice(0, 8).join(' ');

      return QuizQuestion.of({
        question: `What does the video explain about "${subject}"?`,
        answer: scene.writtenText.slice(0, 200),
        sourceMomentSeconds: window ? window.start.seconds : 0,
        citations: scene.citations,
      });
    });

    return { questions, usage: { inputTokens: 0, outputTokens: 0, model: 'stub' } };
  }
}
