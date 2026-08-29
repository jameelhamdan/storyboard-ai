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
    /**
     * True when this scene keeps the previous scene's board and adds to it.
     *
     * This is the difference between a slideshow and an explanation. A video
     * whose every scene wipes to a fresh board makes the viewer rebuild the
     * context each time; the reference explainers instead draw one diagram and
     * grow it, so the thing being explained stays on screen while the narration
     * walks around it. A continuing scene is a *step* of the board it joins —
     * see `Board` and `SceneDiagram.steps`.
     *
     * Always false on the first scene, which has nothing to continue.
     */
    public readonly continuesBoard: boolean,
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
    /** Defaults to false: a scene starts its own board unless it says otherwise. */
    continuesBoard?: boolean;
  }): Scene {
    const spoken = input.spokenText.trim();
    if (!spoken) throw new RangeError(`Scene ${input.index} has no narration.`);
    const written = (input.writtenText ?? spoken).trim();
    return new Scene(
      input.index, spoken, written, (input.sourcedText ?? written).trim(), input.citations,
      input.visualIntent, input.continuesBoard ?? false, undefined, SceneTimeline.unresolved([]),
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
      this.continuesBoard, html, timeline, this.estimatedDuration, this.measuredDuration,
      this.wordTimings, usedFallback,
    );
  }

  /** Applied at stage 8 — measured audio replaces the word-count estimate. */
  public withMeasuredAudio(measured: Duration, timings: readonly WordTiming[]): Scene {
    return new Scene(
      this.index, this.spokenText, this.writtenText, this.sourcedText, this.citations, this.visualIntent,
      this.continuesBoard, this.html, this.timeline.resolve(timings), this.estimatedDuration, measured,
      timings, this.usedFallbackComponent,
    );
  }

  public asFallbackComponent(html: string, timeline: SceneTimeline): Scene {
    /**
     * A fallback board is this scene's own, so it can no longer be a step of
     * whatever board it was joining: the elements it was meant to add do not
     * exist. Breaking the continuation here keeps `groupIntoBoards` honest —
     * otherwise the board would claim a step whose markup is a different
     * diagram entirely.
     */
    return new Scene(
      this.index, this.spokenText, this.writtenText, this.sourcedText, this.citations, this.visualIntent,
      false, html, timeline, this.estimatedDuration, this.measuredDuration, this.wordTimings, true,
    );
  }
}
