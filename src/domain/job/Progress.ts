/**
 * Progress is derived from completed stage weights, never set directly — a stage
 * cannot lie about how far along the job is, and the number is monotonic by
 * construction.
 */
export class Progress {
  private constructor(public readonly percent: number) {}

  public static zero(): Progress {
    return new Progress(0);
  }

  public static of(percent: number): Progress {
    if (!Number.isFinite(percent)) throw new RangeError(`Progress must be finite, got ${percent}.`);
    return new Progress(Math.min(100, Math.max(0, Math.round(percent))));
  }

  /** Weighted completion plus partial credit for the stage currently running. */
  public static fromWeights(completedWeight: number, totalWeight: number, inFlightFraction = 0): Progress {
    if (totalWeight <= 0) return Progress.zero();
    const fraction = (completedWeight + inFlightFraction) / totalWeight;
    return Progress.of(fraction * 100);
  }
}
