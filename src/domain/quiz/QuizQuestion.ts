import type { Citation } from '../content/Citation.js';

/**
 * FR-15. Generated from the *timed* script after alignment, so
 * `source_moment_seconds` is exact rather than estimated.
 */
export class QuizQuestion {
  private constructor(
    public readonly question: string,
    public readonly answer: string,
    public readonly sourceMomentSeconds: number,
    public readonly citations: readonly Citation[],
  ) {}

  public static of(input: {
    question: string; answer: string; sourceMomentSeconds: number; citations: readonly Citation[];
  }): QuizQuestion {
    const question = input.question.trim();
    const answer = input.answer.trim();
    if (!question) throw new RangeError('Quiz question text is empty.');
    if (!answer) throw new RangeError(`Quiz question '${question}' has no answer.`);
    if (input.sourceMomentSeconds < 0) {
      throw new RangeError(`Quiz question '${question}' has a negative source moment.`);
    }
    return new QuizQuestion(question, answer, Math.round(input.sourceMomentSeconds), input.citations);
  }

  public toJSON(): { question: string; answer: string; source_moment_seconds: number } {
    return { question: this.question, answer: this.answer, source_moment_seconds: this.sourceMomentSeconds };
  }
}
