/**
 * How a video should read and look, independent of how many pixels it has.
 *
 * `QualityPreset` decides resolution, fps and codec. This decides voice: the
 * register of the narration and the density of the board. They are separate
 * because a 1080p exam drill and a 1080p gentle walkthrough are the same pixels
 * and completely different videos.
 *
 * Styles are data (`config/styles.yaml`); this is the validated shape. Both
 * fields are prose rather than knobs because prose is what the model acts on —
 * a numeric `density` would have to be turned into a sentence before it could
 * be used, and that sentence is the part worth reviewing.
 */
export class VideoStyle {
  private constructor(
    public readonly name: string,
    public readonly label: string,
    /** Shapes the script: register, pacing, what to lead with. */
    public readonly narration: string,
    /** Shapes the picture: density, what kind of diagram to reach for. */
    public readonly visual: string,
  ) {}

  public static of(input: {
    name: string; label?: string; narration: string; visual: string;
  }): VideoStyle {
    const narration = input.narration.trim();
    const visual = input.visual.trim();

    // An empty half would silently make the style a no-op for that stage, which
    // is worse than refusing to load it: the caller would ask for `exam_drill`
    // and get the default look with no indication why.
    if (!narration) throw new RangeError(`Style '${input.name}': narration is empty.`);
    if (!visual) throw new RangeError(`Style '${input.name}': visual is empty.`);

    return new VideoStyle(input.name, input.label ?? input.name, narration, visual);
  }
}

/**
 * The caller's free-text steer for one video — "focus on the worked example",
 * "keep it under two minutes", "assume they already know calculus".
 *
 * **This is untrusted text that reaches a model prompt.** It cannot be made
 * safe, only bounded: it is length-capped, stripped of control characters, and
 * the prompts that carry it fence it in a labelled block and state that the
 * grounding and citation rules outrank anything inside. A direction can shape
 * the video; it cannot license the model to invent a source.
 */
export class ExtraDirection {
  public static readonly MAX_LENGTH = 500;

  private constructor(public readonly text: string) {}

  public static of(raw: string): ExtraDirection | undefined {
    // Control characters would let a direction fake the delimiters the prompt
    // fences it with, so they go before anything else looks at the string.
    const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) return undefined;

    if (cleaned.length > ExtraDirection.MAX_LENGTH) {
      throw new RangeError(
        `direction is ${cleaned.length} characters; the limit is ${ExtraDirection.MAX_LENGTH}. ` +
        'It is a steer for one video, not a second brief.',
      );
    }
    return new ExtraDirection(cleaned);
  }
}
