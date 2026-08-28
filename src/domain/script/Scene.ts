import type { Duration } from '../shared/Duration.js';
import type { Citation } from '../content/Citation.js';
import type { WordTiming } from '../media/WordTiming.js';
import { SceneTimeline } from './SceneTimeline.js';
import type { DiagramShape } from './DiagramShape.js';

/**
 * One storyboard unit. Carries three narration forms:
 *  - `spokenText` is what TTS synthesizes and what `data-on` anchors match against
 *  - `writtenText` is what subtitles display ("50%" rather than "fifty percent")
 *  - `sourcedText` is the subset that states source facts, for traceability
 *
 * The first two diverge only in presentation, and timing is always keyed on the
 * spoken form. The third is a different cut entirely: narration may include a
 * capped number of *teaching* sentences — a hook, an analogy, a transition —
 * which assert nothing about the subject and carry no citation. Those belong in
 * the video and not in a hallucination audit, so `traceability.json` is built
 * from `sourcedText` rather than from what was said.
 */
export class Scene {
  private constructor(
    public readonly index: number,
    public readonly spokenText: string,
    public readonly writtenText: string,
    public readonly sourcedText: string,
    public readonly citations: readonly Citation[],
    public readonly visualIntent: DiagramShape,
    public readonly html: string | undefined,
    public readonly timeline: SceneTimeline,
    public readonly estimatedDuration: Duration,
    public readonly measuredDuration: Duration | undefined,
    public readonly wordTimings: readonly WordTiming[],
    public readonly usedFallbackComponent: boolean,
  ) {}

  public static of(input: {
    index: number;
    spokenText: string;
    writtenText?: string;
    /** Defaults to the written text, for callers with no teaching sentences. */
    sourcedText?: string;
    citations: readonly Citation[];
    visualIntent: DiagramShape;
    estimatedDuration: Duration;
  }): Scene {
    const spoken = input.spokenText.trim();
    if (!spoken) throw new RangeError(`Scene ${input.index} has no narration.`);
    const written = (input.writtenText ?? spoken).trim();
    return new Scene(
      input.index, spoken, written, (input.sourcedText ?? written).trim(), input.citations,
      input.visualIntent, undefined, SceneTimeline.unresolved([]),
      input.estimatedDuration, undefined, [], false,
    );
  }

  /** The duration that counts: measured audio once we have it, estimate before. */
  public get duration(): Duration {
    return this.measuredDuration ?? this.estimatedDuration;
  }

  public get wordCount(): number {
    return this.spokenText.split(/\s+/).filter(Boolean).length;
  }

  public withStoryboard(html: string, timeline: SceneTimeline, usedFallback = false): Scene {
    return new Scene(
      this.index, this.spokenText, this.writtenText, this.sourcedText, this.citations, this.visualIntent,
      html, timeline, this.estimatedDuration, this.measuredDuration, this.wordTimings, usedFallback,
    );
  }

  /** Applied at stage 8 — measured audio replaces the word-count estimate. */
  public withMeasuredAudio(measured: Duration, timings: readonly WordTiming[]): Scene {
    return new Scene(
      this.index, this.spokenText, this.writtenText, this.sourcedText, this.citations, this.visualIntent,
      this.html, this.timeline.resolve(timings), this.estimatedDuration, measured, timings, this.usedFallbackComponent,
    );
  }

  public asFallbackComponent(html: string, timeline: SceneTimeline): Scene {
    return this.withStoryboard(html, timeline, true);
  }
}
