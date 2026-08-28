import { Duration } from '../shared/Duration.js';

/**
 * Comes from the synthesiser itself, so it is exact rather than force-aligned —
 * which is what makes FR-8's 100ms tolerance straightforward rather than a fight.
 */
export class WordTiming {
  private constructor(
    public readonly word: string,
    public readonly start: Duration,
    public readonly end: Duration,
  ) {}

  public static of(word: string, startMs: number, endMs: number): WordTiming {
    if (endMs < startMs) throw new RangeError(`WordTiming '${word}': end (${endMs}) precedes start (${startMs}).`);
    return new WordTiming(word, Duration.fromMs(startMs), Duration.fromMs(endMs));
  }

  public get duration(): Duration {
    return this.end.minus(this.start);
  }

  public shiftedBy(offset: Duration): WordTiming {
    return new WordTiming(this.word, this.start.plus(offset), this.end.plus(offset));
  }

  /** Comparison key for phrase matching: case- and punctuation-insensitive. */
  public get normalised(): string {
    return this.word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }
}

/**
 * Resolves a `data-on` phrase to the moment its first word is spoken.
 * Rules mirror docs/scene-contract.md §2:
 *   - case-insensitive, whitespace-normalised
 *   - first occurrence wins when a phrase repeats
 *   - no match returns undefined; the caller applies the documented fallback
 *
 * **Why an exact match is not enough.** Word timings are only guaranteed to be
 * the narration verbatim when the synthesiser aligns against the text it was
 * given. A provider without native timings has its output transcribed to
 * recover them, and a transcriber mishears — a contraction splits, a number
 * comes back as a digit. The anchor then misses, the element inherits the
 * previous one's time, and several reveals silently bunch onto one moment.
 *
 * So: exact contiguous match first, and only if that fails, the longest partial
 * run of the phrase. Anchoring to most of the phrase is a few frames off;
 * inheriting is a visibly wrong reveal.
 */
export function resolvePhrase(phrase: string, timings: readonly WordTiming[]): Duration | undefined {
  const needle = phrase.toLowerCase().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (needle.length === 0) return undefined;

  const exact = findContiguous(needle, timings);
  if (exact) return exact;

  /**
   * Fall back to the longest *leading* run of the phrase.
   *
   * A prefix rather than any matching slice, because an anchor marks where the
   * phrase begins — that is the moment the element should appear. Matching a
   * later slice would anchor to the wrong instant.
   */
  for (let length = needle.length - 1; length >= 1; length -= 1) {
    // A single short word is not evidence: "the" or "of" occurs everywhere, and
    // anchoring an element to the first one is worse than inheriting a time.
    if (length === 1 && (needle[0]?.length ?? 0) < 4) break;

    const at = findContiguous(needle.slice(0, length), timings);
    if (at) return at;
  }
  return undefined;
}

/** The start of the first run of `needle` appearing consecutively in `timings`. */
function findContiguous(
  needle: readonly string[], timings: readonly WordTiming[],
): Duration | undefined {
  for (let i = 0; i <= timings.length - needle.length; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (timings[i + j]?.normalised !== needle[j]) { matched = false; break; }
    }
    if (matched) return timings[i]?.start;
  }
  return undefined;
}
