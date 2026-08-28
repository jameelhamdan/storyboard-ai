import type { GateId } from '../quality/QualityScore.js';

export interface RetryBudgetConfig {
  readonly maxSceneRetries: number;
  readonly maxFallbackScenes: number;
}

export type RetryDecision =
  | { readonly action: 'regenerate'; readonly attempt: number; readonly failedGates: readonly GateId[] }
  | { readonly action: 'stop'; readonly reason: string };

/**
 * Whether a failing scene is worth another attempt.
 *
 * Two things changed after watching this run for real, and both were the same
 * mistake — deciding without looking at what was actually produced.
 *
 * **It no longer decides what ships.** The old version returned `fallback`, and
 * the stage acted on that by discarding the model's board and substituting a
 * synthetic one that was never judged. In `out/20260827-202226-battery` that
 * traded a legible cycle diagram for four truncated narration fragments, twice.
 * Choosing between the attempts is the stage's job, because only the stage has
 * them; this decides when to stop paying for more.
 *
 * **It sees how badly the scene failed.** Previously `decide` took only the
 * attempt number, so one failed gate and four were the same input and got the
 * same three retries. A board failing a single wording gate is close, and a
 * board failing four is not going to converge — spending the same budget on
 * both is how the judge became 80% of runtime.
 */
export class RetryBudgetPolicy {
  constructor(private readonly config: RetryBudgetConfig) {}

  public decide(input: { attempt: number; failedGates: readonly GateId[] }): RetryDecision {
    const budget = this.budgetFor(input.failedGates.length);

    if (input.attempt < budget) {
      return { action: 'regenerate', attempt: input.attempt + 1, failedGates: input.failedGates };
    }

    return {
      action: 'stop',
      reason: input.failedGates.length > 0
        ? `Scene exhausted ${budget} attempt(s) on ${input.failedGates.join(', ')}.`
        : `Scene exhausted ${budget} attempt(s).`,
    };
  }

  /**
   * A near-miss earns the full budget; a board wrong in several ways earns one
   * correction and then we take the best of what we have.
   */
  private budgetFor(failedGateCount: number): number {
    return failedGateCount >= 3 ? 1 : this.config.maxSceneRetries;
  }

  /**
   * Whether the finished video leans on too many last-resort boards.
   *
   * Checked once over the whole storyboard rather than incrementally inside the
   * per-scene loop. That is what lets scenes be judged concurrently: the old
   * running counter was read and written per scene, so parallelism would have
   * made which scene tripped the limit depend on timing.
   */
  public exceedsFallbackBudget(fallbackScenes: number): string | undefined {
    if (fallbackScenes <= this.config.maxFallbackScenes) return undefined;
    return `${fallbackScenes} scenes produced nothing renderable; the limit is ${this.config.maxFallbackScenes}.`;
  }
}
