/**
 * The whiteboard look, as data.
 *
 * docs/whiteboard-style.md is explicit that the aesthetic is defined entirely by
 * these tokens so it can be retuned without touching a component — which only
 * holds if the renderer reads them rather than restating them. Every renderer,
 * present and future, takes its colours and type scale from here.
 */
export interface ThemeTokens {
  readonly board: {
    readonly background: string;
    readonly paddingRem: number;
    /** `none` or `subtle` — a faint edge shadow that stops the board looking like a flat div. */
    readonly vignette: string;
  };
  readonly ink: {
    readonly primary: string;
    readonly secondary: string;
    readonly accent: string;
    /**
     * The full accent set, primary first.
     *
     * docs/whiteboard-style.md originally allowed exactly one accent. That was
     * reversed: parallel things — the arms of a comparison, the bands of a
     * stack — need to be told apart, and a single accent forced everything else
     * into greys.
     */
    readonly accents: readonly string[];
    readonly muted: string;
  };
  /**
   * Pen geometry. These are what stop a border reading as a CSS box: a marker
   * has a width, rounds its corners, and does not draw perfectly straight.
   */
  readonly stroke: {
    readonly widthPx: number;
    readonly linecap: string;
    /** 0..1. Drives the hand-drawn wobble on borders and rules. */
    readonly jitter: number;
    readonly cornerRadiusPx: number;
  };
  readonly type: {
    readonly family: string;
    readonly titleRem: number;
    readonly bodyRem: number;
    readonly labelRem: number;
    readonly minRem: number;
    readonly lineHeight: number;
    readonly letterSpacingEm: number;
  };
  readonly motion: {
    readonly drawMsPer100px: number;
    readonly revealMs: number;
    readonly staggerMs: number;
    /** A cubic-bezier, resolved to easing coefficients by the seek script. */
    readonly ease: string;
  };
}

export class Theme {
  private constructor(public readonly name: string, public readonly tokens: ThemeTokens) {}

  public static of(name: string, tokens: ThemeTokens): Theme {
    if (!/^#[0-9a-fA-F]{6}$/.test(tokens.board.background)) {
      throw new RangeError(`Theme '${name}': board.background must be a 6-digit hex colour.`);
    }
    // `ink.accents` is a list; every other ink token is a single colour. Both
    // are flattened here so a bad hex in the palette fails as loudly as one in
    // `ink.primary` rather than reaching a stylesheet.
    for (const [key, value] of Object.entries(tokens.ink)) {
      const colours = Array.isArray(value) ? value : [value];
      for (const colour of colours) {
        if (!/^#[0-9a-fA-F]{6}$/.test(colour)) {
          throw new RangeError(`Theme '${name}': ink.${key} must be a 6-digit hex colour, got '${colour}'.`);
        }
      }
    }
    if (tokens.type.minRem <= 0) {
      throw new RangeError(`Theme '${name}': type.minRem must be positive — it is the legibility floor.`);
    }
    return new Theme(name, tokens);
  }


  /**
   * rem is relative to a root font size, which a frame renderer does not have —
   * so the scale is resolved against frame height. 16px at 720p is the implicit
   * root the type scale in docs/whiteboard-style.md was chosen against.
   */
  /**
   * The tokens as CSS custom properties, for the browser renderer.
   *
   * Emitting them rather than restating them in a stylesheet is what keeps
   * `docs/whiteboard-style.md`'s promise that the look is retuned by editing
   * `theme.yaml` and nothing else. The motion values are included because they
   * drive the reveal animation — before this they were parsed into `Theme` and
   * read by nobody.
   */
  public toCssVariables(): string {
    const t = this.tokens;
    const lines = [
      `--board-bg: ${t.board.background};`,
      `--board-padding: ${t.board.paddingRem}rem;`,
      `--board-vignette: ${t.board.vignette};`,
      `--ink-primary: ${t.ink.primary};`,
      `--ink-secondary: ${t.ink.secondary};`,
      `--ink-accent: ${t.ink.accent};`,
      ...t.ink.accents.map((accent, i) => `--ink-accent-${i + 1}: ${accent};`),
      `--ink-muted: ${t.ink.muted};`,
      `--type-family: ${t.type.family};`,
      `--type-title: ${t.type.titleRem}rem;`,
      `--type-body: ${t.type.bodyRem}rem;`,
      `--type-label: ${t.type.labelRem}rem;`,
      `--type-min: ${t.type.minRem}rem;`,
      `--type-line-height: ${t.type.lineHeight};`,
      `--type-letter-spacing: ${t.type.letterSpacingEm}em;`,
      `--stroke-width: ${t.stroke.widthPx}px;`,
      `--stroke-linecap: ${t.stroke.linecap};`,
      `--stroke-jitter: ${t.stroke.jitter};`,
      `--stroke-radius: ${t.stroke.cornerRadiusPx}px;`,
      `--motion-draw-ms-per-100px: ${t.motion.drawMsPer100px};`,
      `--motion-reveal-ms: ${t.motion.revealMs};`,
      `--motion-stagger-ms: ${t.motion.staggerMs};`,
      `--motion-ease: ${t.motion.ease};`,
    ];
    return lines.join('\n  ');
  }

}
