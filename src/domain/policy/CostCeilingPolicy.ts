import { Money } from '../shared/Money.js';
import type { GenerationCost } from '../cost/GenerationCost.js';

/**
 * Per-job circuit breaker. A runaway regeneration loop is the realistic way a job
 * burns money, and the retry budget alone does not bound total spend once several
 * stages each retry.
 */
export class CostCeilingPolicy {
  private readonly ceiling: Money;

  constructor(ceilingUsd: number) {
    this.ceiling = Money.fromUsd(ceilingUsd);
  }

  public hasBreached(cost: GenerationCost): boolean {
    return cost.total.isGreaterThan(this.ceiling);
  }

  /** Checked *before* an expensive call, so the ceiling bounds spend rather than reporting it. */
  public wouldBreach(cost: GenerationCost, projected: Money): boolean {
    return cost.total.plus(projected).isGreaterThan(this.ceiling);
  }

  public get ceilingUsd(): number {
    return this.ceiling.usd;
  }

  public remaining(cost: GenerationCost): Money {
    const spent = cost.total;
    return spent.isGreaterThan(this.ceiling)
      ? Money.zero()
      : Money.fromMicros(this.ceiling.micros - spent.micros);
  }
}
