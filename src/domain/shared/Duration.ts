/** Milliseconds internally; seconds is a presentation concern. */
export class Duration {
  private constructor(public readonly ms: number) {}

  public static fromMs(ms: number): Duration {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`Duration must be a non-negative finite number of ms, got ${ms}.`);
    return new Duration(Math.round(ms));
  }

  public static fromSeconds(seconds: number): Duration {
    return Duration.fromMs(seconds * 1000);
  }

  public static zero(): Duration {
    return new Duration(0);
  }

  public static sum(durations: readonly Duration[]): Duration {
    return Duration.fromMs(durations.reduce((total, d) => total + d.ms, 0));
  }

  public get seconds(): number {
    return this.ms / 1000;
  }

  public plus(other: Duration): Duration {
    return Duration.fromMs(this.ms + other.ms);
  }

  public minus(other: Duration): Duration {
    return Duration.fromMs(Math.max(0, this.ms - other.ms));
  }

  public clamp(min: Duration, max: Duration): Duration {
    if (min.ms > max.ms) throw new RangeError('clamp(min, max) called with min > max.');
    return Duration.fromMs(Math.min(Math.max(this.ms, min.ms), max.ms));
  }

  public isBetween(min: Duration, max: Duration): boolean {
    return this.ms >= min.ms && this.ms <= max.ms;
  }

  /** Frame index at a given fps. The renderer's only unit conversion. */
  public toFrames(fps: number): number {
    if (fps <= 0) throw new RangeError(`fps must be positive, got ${fps}.`);
    return Math.round((this.ms / 1000) * fps);
  }

  /** SRT wants `HH:MM:SS,mmm`; ffmpeg wants `HH:MM:SS.mmm`. */
  public toTimecode(msSeparator: ',' | '.' = ','): string {
    const totalMs = this.ms;
    const h = Math.floor(totalMs / 3_600_000);
    const m = Math.floor((totalMs % 3_600_000) / 60_000);
    const s = Math.floor((totalMs % 60_000) / 1000);
    const frac = totalMs % 1000;
    const pad = (n: number, width = 2) => String(n).padStart(width, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}${msSeparator}${pad(frac, 3)}`;
  }

  public toString(): string {
    return this.toTimecode();
  }
}
