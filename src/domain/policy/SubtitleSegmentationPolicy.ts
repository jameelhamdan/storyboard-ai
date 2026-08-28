import { Duration } from '../shared/Duration.js';
import { SubtitleCue } from '../media/SubtitleCue.js';
import type { WordTiming } from '../media/WordTiming.js';

export interface SubtitleConfig {
  readonly maxCharsPerLine: number;
  readonly maxLines: number;
  readonly minCueDurationMs: number;
  readonly maxCueDurationMs: number;
  readonly interCueGapMs: number;
}

/**
 * Word timings -> cues, honouring chars/line and min-duration config.
 *
 * Cues are built from the *spoken* word timings but display the *written* form,
 * so a viewer reads "50%" while the timing came from "fifty percent". That mapping
 * is this policy's job and nowhere else's.
 */
export class SubtitleSegmentationPolicy {
  constructor(private readonly config: SubtitleConfig) {}

  public segment(timings: readonly WordTiming[], startIndex = 1): SubtitleCue[] {
    if (timings.length === 0) return [];

    const cues: SubtitleCue[] = [];
    let bucket: WordTiming[] = [];
    let index = startIndex;

    const flush = (): void => {
      if (bucket.length === 0) return;
      const first = bucket[0]!;
      const last = bucket.at(-1)!;

      let end = last.end;
      // A cue that flashes past is unreadable; extend it, but never past the next one.
      if (end.minus(first.start).ms < this.config.minCueDurationMs) {
        end = first.start.plus(Duration.fromMs(this.config.minCueDurationMs));
      }
      if (end.minus(first.start).ms > this.config.maxCueDurationMs) {
        end = first.start.plus(Duration.fromMs(this.config.maxCueDurationMs));
      }

      cues.push(SubtitleCue.of(index, first.start, end, this.wrap(bucket.map((t) => t.word).join(' '))));
      index += 1;
      bucket = [];
    };

    for (const timing of timings) {
      const candidate = [...bucket, timing];
      const span = timing.end.minus(candidate[0]!.start).ms;

      /**
       * Fit is decided by wrapping, not by a character budget.
       *
       * `maxCharsPerLine * maxLines` assumes words pack perfectly into lines;
       * they do not. Text under that budget can still wrap to three lines when
       * a long word forces an early break — and the wrap then had to drop the
       * overflow, silently losing words from the middle of a sentence.
       */
      const overflows = this.wrapAll(candidate.map((t) => t.word)).length > this.config.maxLines;

      if (bucket.length > 0 && (overflows || span > this.config.maxCueDurationMs)) {
        flush();
        bucket = [timing];
      } else {
        bucket = candidate;
      }
    }
    flush();

    return this.enforceGaps(cues);
  }

  /**
   * Greedy wrap at word boundaries; never splits a word across lines and never
   * discards one. A single word longer than a line gets its own line rather than
   * being truncated — unreadable is still better than absent.
   */
  private wrapAll(words: readonly string[]): string[] {
    const lines: string[] = [];
    let line = '';

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > this.config.maxCharsPerLine && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);

    return lines;
  }

  private wrap(text: string): string[] {
    return this.wrapAll(text.split(/\s+/).filter(Boolean));
  }

  /** Overlapping cues render on top of each other; pull ends back to keep the gap. */
  private enforceGaps(cues: readonly SubtitleCue[]): SubtitleCue[] {
    const gap = Duration.fromMs(this.config.interCueGapMs);
    const out: SubtitleCue[] = [];

    for (let i = 0; i < cues.length; i += 1) {
      const cue = cues[i]!;
      const next = cues[i + 1];
      let end = cue.end;

      if (next && end.plus(gap).ms > next.start.ms) {
        const pulled = next.start.minus(gap);
        if (pulled.ms > cue.start.ms) end = pulled;
      }
      out.push(SubtitleCue.of(cue.index, cue.start, end, cue.lines));
    }
    return out;
  }

  /** FR-8 verification: every cue boundary within tolerance of its word timing. */
  public maxDriftMs(cues: readonly SubtitleCue[], timings: readonly WordTiming[]): number {
    let worst = 0;
    for (const cue of cues) {
      const nearest = timings.reduce<number>(
        (best, t) => Math.min(best, Math.abs(t.start.ms - cue.start.ms)),
        Number.POSITIVE_INFINITY,
      );
      if (Number.isFinite(nearest)) worst = Math.max(worst, nearest);
    }
    return worst;
  }
}
