/**
 * Integer micro-USD. Cost accumulates across ~70 LLM calls per job at fractions
 * of a cent each; floating-point drift over that many additions is exactly the
 * kind of thing that makes a cost report unreconcilable with an invoice.
 */
export class Money {
  private static readonly MICROS_PER_USD = 1_000_000;

  private constructor(public readonly micros: number) {}

  public static fromMicros(micros: number): Money {
    if (!Number.isFinite(micros)) throw new RangeError(`Money requires a finite value, got ${micros}.`);
    if (micros < 0) throw new RangeError(`Money cannot be negative, got ${micros} micros.`);
    return new Money(Math.round(micros));
  }

  public static fromUsd(usd: number): Money {
    return Money.fromMicros(usd * Money.MICROS_PER_USD);
  }

  public static zero(): Money {
    return new Money(0);
  }

  public static sum(amounts: readonly Money[]): Money {
    return Money.fromMicros(amounts.reduce((total, m) => total + m.micros, 0));
  }

  public get usd(): number {
    return this.micros / Money.MICROS_PER_USD;
  }

  public plus(other: Money): Money {
    return Money.fromMicros(this.micros + other.micros);
  }

  public times(factor: number): Money {
    if (factor < 0) throw new RangeError(`Cannot scale Money by a negative factor (${factor}).`);
    return Money.fromMicros(this.micros * factor);
  }

  /** Per-video-minute cost — the unit the configured cost target is expressed in. */
  public perMinute(durationSeconds: number): Money {
    if (durationSeconds <= 0) return Money.zero();
    return Money.fromMicros(this.micros / (durationSeconds / 60));
  }

  public isGreaterThan(other: Money): boolean {
    return this.micros > other.micros;
  }

  /** Rounded for the API payload; the ledger keeps full precision. */
  public toUsdRounded(dp = 4): number {
    return Number(this.usd.toFixed(dp));
  }

  public toString(): string {
    return `$${this.usd.toFixed(6)}`;
  }
}
