import { Duration } from '../shared/Duration.js';
import { resolvePhrase, type WordTiming } from '../media/WordTiming.js';

export type DrawSpeed = 'fast' | 'normal' | 'slow';

/**
 * One element's reveal, as the LLM wrote it: a *phrase*, never a number.
 * The model has no idea how long the TTS will take to say anything, so letting it
 * write times would guarantee drift. Resolution happens here, against real timings.
 */
export interface TimelineAnchor {
  readonly elementId: string;
  readonly phrase: string | undefined;
  readonly draw: DrawSpeed;
  readonly hold: boolean;
  /**
   * Which step of the board's build this element belongs to, 1-based.
   *
   * A board spans several scenes, and each scene owns only its own step's
   * anchors — their phrases appear in that scene's narration and are resolved
   * against that scene's measured timings. Splitting on this is what lets one
   * shared board carry several scenes' timings without any of them resolving a
   * phrase from a scene it never narrated.
   *
   * Optional, and absent means 1. A board of one scene has exactly one step, so
   * every caller that predates boards is describing step 1 whether it says so
   * or not.
   */
  readonly step?: number;
}

export interface ResolvedReveal {
  readonly elementId: string;
  readonly at: Duration;
  readonly draw: DrawSpeed;
  readonly hold: boolean;
  /** True when the phrase did not match and the documented fallback was applied. */
  readonly fallback: boolean;
}

export class SceneTimeline {
  private constructor(
    public readonly anchors: readonly TimelineAnchor[],
    public readonly reveals: readonly ResolvedReveal[],
    public readonly unmatchedAnchors: readonly string[],
  ) {}

  public static unresolved(anchors: readonly TimelineAnchor[]): SceneTimeline {
    return new SceneTimeline(anchors, [], []);
  }

  /**
   * Resolve every anchor against measured word timings.
   *
   * Fallback rules are docs/scene-contract.md §2, applied verbatim:
   *   4. no `data-on` -> reveals at scene start
   *   3. no match     -> inherits the previous element's time, recorded as a warning
   *   5. reveal order is resolved time, not document order, so the model cannot
   *      create an impossible sequence
   */
  public resolve(timings: readonly WordTiming[]): SceneTimeline {
    const reveals: ResolvedReveal[] = [];
    const unmatched: string[] = [];
    let previous = Duration.zero();

    for (const anchor of this.anchors) {
      let at: Duration;
      let fallback = false;

      if (anchor.phrase === undefined) {
        at = Duration.zero();
      } else {
        const resolved = resolvePhrase(anchor.phrase, timings);
        if (resolved) {
          at = resolved;
        } else {
          at = previous;
          fallback = true;
          unmatched.push(anchor.phrase);
        }
      }

      previous = at;
      reveals.push({ elementId: anchor.elementId, at, draw: anchor.draw, hold: anchor.hold, fallback });
    }

    reveals.sort((a, b) => a.at.ms - b.at.ms);
    return new SceneTimeline(this.anchors, reveals, unmatched);
  }
}
