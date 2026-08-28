import { Duration } from '../shared/Duration.js';
import type { LanguageCode } from '../shared/Language.js';
import type { VolumeStatistics } from '../content/ConsolidatedContent.js';

export interface DurationConfig {
  readonly minSeconds: number;
  readonly maxSeconds: number;
  readonly secondsPerHundredWords: number;
  readonly wordsPerMinute: Readonly<Record<string, number>>;
}

/**
 * Consolidated volume -> target duration, clamped to the preset's bounds.
 *
 * FR-4: "longer content gets summarised, not truncated mid-sentence" — so this
 * returns a *target for the script generator*, not a cut point. Nothing downstream
 * truncates; the script is written to fit.
 */
export class DurationPolicy {
  constructor(private readonly config: DurationConfig) {}

  public targetFor(stats: VolumeStatistics, requested?: Duration): Duration {
    const min = Duration.fromSeconds(this.config.minSeconds);
    const max = Duration.fromSeconds(this.config.maxSeconds);

    // A caller hint is a hint: honoured, but never outside the hard bounds.
    if (requested) return requested.clamp(min, max);

    const derived = Duration.fromSeconds((stats.totalWords / 100) * this.config.secondsPerHundredWords);
    return derived.clamp(min, max);
  }

  /** Words the narration may use to fill a target at the language's pace. */
  public wordBudgetFor(target: Duration, language: LanguageCode): number {
    const wpm = this.config.wordsPerMinute[language] ?? this.config.wordsPerMinute['en'] ?? 150;
    return Math.round((target.seconds / 60) * wpm);
  }

  /**
   * Provisional per-scene window from word count. A sanity bound for Stage A only —
   * measured audio replaces it at the re-timing stage.
   */
  public estimateSpokenDuration(wordCount: number, language: LanguageCode): Duration {
    const wpm = this.config.wordsPerMinute[language] ?? this.config.wordsPerMinute['en'] ?? 150;
    return Duration.fromSeconds((wordCount / wpm) * 60);
  }

  public isWithinBounds(actual: Duration): boolean {
    return actual.isBetween(
      Duration.fromSeconds(this.config.minSeconds),
      Duration.fromSeconds(this.config.maxSeconds),
    );
  }
}
