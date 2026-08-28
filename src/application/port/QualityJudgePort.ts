import type { Scene } from '@domain/script/Scene.js';
import type { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import type { GateResult, HolisticScore } from '@domain/quality/QualityScore.js';
import type { TokenUsage } from './CostMeterPort.js';

export interface SceneJudgement {
  readonly sceneIndex: number;
  readonly gates: readonly GateResult[];
  readonly holistic: HolisticScore | undefined;
  readonly usage: TokenUsage;
}

/** Stage A is deterministic and lives in infrastructure; Stage B needs a model. */
export interface QualityJudgePort {
  judgeScene(input: {
    scene: Scene;
    content: ConsolidatedContent;
    screenshotPaths: readonly string[];
    /** What the visual plan said this scene should show, if anything. */
    plannedConcept?: string;
    signal?: AbortSignal;
  }): Promise<SceneJudgement>;
}
