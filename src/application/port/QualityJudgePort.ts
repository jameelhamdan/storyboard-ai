import type { Board } from '@domain/script/Board.js';
import type { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import type { GateResult, HolisticScore } from '@domain/quality/QualityScore.js';
import type { TokenUsage } from './CostMeterPort.js';

export interface BoardJudgement {
  /** The board's first scene, for logging and for matching a result back. */
  readonly sceneIndex: number;
  readonly gates: readonly GateResult[];
  readonly holistic: HolisticScore | undefined;
  readonly usage: TokenUsage;
}

/**
 * Stage A is deterministic and lives in infrastructure; Stage B needs a model.
 *
 * The unit is the **board**, not the scene. A board's scenes share one diagram,
 * so every gate this asks about — is the picture grounded, does it fit what the
 * narration states, is anything key missing, does it read well — has one answer
 * for the whole board. Asking it per scene sent the rubric, the source excerpt
 * and the gate definitions once per scene to review the same picture, which was
 * 45% of a real run's bill.
 */
export interface QualityJudgePort {
  judgeBoard(input: {
    board: Board;
    content: ConsolidatedContent;
    /**
     * One frame per step, in order — the board as the viewer meets it.
     *
     * A built board judged from its final frame alone cannot be assessed for
     * pacing: every element is present there by definition. The sequence is what
     * makes "did this arrive when the narration needed it" answerable at all.
     */
    readonly screenshotPaths: readonly string[];
    /** What the visual plan said this board should show, if anything. */
    plannedConcept?: string;
    signal?: AbortSignal;
  }): Promise<BoardJudgement>;
}
