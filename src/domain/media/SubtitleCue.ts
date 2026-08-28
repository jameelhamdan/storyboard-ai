import type { Duration } from '../shared/Duration.js';

/** One SRT cue. Serialisation lives in infrastructure; this is the shape. */
export class SubtitleCue {
  private constructor(
    public readonly index: number,
    public readonly start: Duration,
    public readonly end: Duration,
    public readonly lines: readonly string[],
  ) {}

  public static of(index: number, start: Duration, end: Duration, lines: readonly string[]): SubtitleCue {
    if (end.ms <= start.ms) throw new RangeError(`Cue ${index}: end must follow start (${start} -> ${end}).`);
    if (lines.length === 0) throw new RangeError(`Cue ${index} has no text.`);
    return new SubtitleCue(index, start, end, lines);
  }

  public get text(): string {
    return this.lines.join('\n');
  }

  public get duration(): Duration {
    return this.end.minus(this.start);
  }

  public overlaps(other: SubtitleCue): boolean {
    return this.start.ms < other.end.ms && other.start.ms < this.end.ms;
  }
}
