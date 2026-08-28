/**
 * The binary gates from docs/judge-rubric.md. Pass/fail, never a number.
 *
 * G5 (consistency with the preceding scene) was removed rather than fixed. It
 * asked whether this board sits with the one before it, and the judge was only
 * ever sent one screenshot — its own — so the comparison had no input and the
 * gate passed unconditionally while still costing image tokens on every call.
 * The property it was after is now structural: every board is laid out by the
 * same templates from the same theme, so scenes cannot drift apart in register
 * the way free-form markup did.
 */
export const GATES = ['G1', 'G2', 'G3', 'G4'] as const;
export type GateId = (typeof GATES)[number];

export interface GateResult {
  readonly gate: GateId;
  readonly passed: boolean;
  readonly note?: string;
}

/**
 * A 1-5 holistic score, reported and never gated on. Model numeric scores drift
 * between runs; thresholding on them would make the gate flaky and the threshold
 * arbitrary. It exists to track quality across iterations, not to decide anything.
 */
export class HolisticScore {
  private constructor(public readonly value: number) {}

  public static of(value: number): HolisticScore {
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      throw new RangeError(`Holistic score must be within 1-5, got ${value}.`);
    }
    return new HolisticScore(Math.round(value * 10) / 10);
  }

  public static mean(scores: readonly HolisticScore[]): HolisticScore | undefined {
    if (scores.length === 0) return undefined;
    return HolisticScore.of(scores.reduce((t, s) => t + s.value, 0) / scores.length);
  }
}
