import type { GateResult, GateId } from '../quality/QualityScore.js';

export interface GateVerdict {
  readonly passed: boolean;
  readonly failedGates: readonly GateId[];
}

/**
 * Gates -> pass/fail.
 *
 * A scene passes only if every gate passes. The holistic score is deliberately
 * not part of the decision: model numeric scores drift between runs, so gating
 * on one would make the gate flaky and its threshold arbitrary.
 *
 * There used to be a `holisticScoreReportedOnly` config flag and a
 * `gatesOnHolistic()` method guarding exactly that. No production code ever
 * called it — the score was reported and nothing else, whatever the flag said —
 * so the flag documented an option that did not exist. The comment above is the
 * honest version of it.
 */
export class JudgeThresholdPolicy {
  public evaluate(gates: readonly GateResult[]): GateVerdict {
    const failed = gates.filter((g) => !g.passed).map((g) => g.gate);
    return { passed: failed.length === 0, failedGates: failed };
  }
}
