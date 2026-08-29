import type { QualityJudgePort, BoardJudgement } from '@application/port/QualityJudgePort.js';
import type { Board } from '@domain/script/Board.js';
import { GATES, HolisticScore, type GateResult } from '@domain/quality/QualityScore.js';

/**
 * Passes every gate and reports a fixed score.
 *
 * This is the one stub that is *not* a partial implementation, and the distinction
 * matters: with it wired in, the judge is not testing anything. It exists so the
 * pipeline shape is exercised end to end at M2, and it must be replaced at M7
 * before any quality claim is made. Anything it reports is a placeholder, not a
 * measurement.
 */
export class StubQualityJudge implements QualityJudgePort {
  public async judgeBoard(input: { board: Board }): Promise<BoardJudgement> {
    const gates: GateResult[] = GATES.map((gate) => ({
      gate,
      passed: true,
      note: 'stub judge — not evaluated',
    }));

    return {
      sceneIndex: input.board.firstScene.index,
      gates,
      holistic: HolisticScore.of(3),
      usage: { inputTokens: 0, outputTokens: 0, model: 'stub' },
    };
  }
}
