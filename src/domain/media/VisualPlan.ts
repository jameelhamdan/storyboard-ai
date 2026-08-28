/**
 * The whole video's visual design, decided once before any scene is written.
 *
 * Scenes are authored independently and in parallel, so without a shared plan
 * each one picks its own colours and its own idea of what the video looks like.
 * Ten uncorrelated choices read as a ransom note rather than as a design. This
 * is the thing that makes them agree.
 */

export interface Palette {
  /** The board. */
  readonly ground: string;
  /** Main marker. */
  readonly ink: string;
  /**
   * Two to four accents, chosen for this subject. The first is the primary
   * emphasis colour; the rest distinguish parallel things — the arms of a
   * comparison, the bands of a stack.
   */
  readonly accents: readonly string[];
  /** Axes, gridlines, de-emphasised detail. */
  readonly muted: string;
}

export interface ScenePlan {
  readonly sceneIndex: number;
  /** What this scene should show, in a sentence. Judged against the render. */
  readonly concept: string;
  /** Terms the scene must foreground. */
  readonly emphasis: readonly string[];
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** How many `--ink-accent-N` slots the stylesheet may reference. */
const ACCENT_SLOTS = 4;

/**
 * WCAG AA for large text, which is what every token on a 720p board is.
 * docs/whiteboard-style.md makes this non-negotiable.
 */
const MIN_CONTRAST = 4.5;

export class VisualPlan {
  private constructor(
    public readonly palette: Palette,
    public readonly scenes: readonly ScenePlan[],
  ) {}

  public static of(input: { palette: Palette; scenes: readonly ScenePlan[] }): VisualPlan {
    const { palette } = input;

    for (const [role, value] of [
      ['ground', palette.ground], ['ink', palette.ink], ['muted', palette.muted],
      ...palette.accents.map((a, i) => [`accents[${i}]`, a] as const),
    ] as const) {
      if (!HEX.test(value)) {
        throw new RangeError(`Palette ${role} must be a six-digit hex colour, got '${value}'.`);
      }
    }

    if (palette.accents.length < 1 || palette.accents.length > 4) {
      throw new RangeError(`Palette needs one to four accents, got ${palette.accents.length}.`);
    }

    // A palette the model likes but nobody can read is worse than a dull one,
    // and it would poison every scene in the video rather than just one.
    const inkContrast = contrastRatio(palette.ink, palette.ground);
    if (inkContrast < MIN_CONTRAST) {
      throw new RangeError(
        `Ink ${palette.ink} on ground ${palette.ground} has contrast ${inkContrast.toFixed(2)}; ` +
        `${MIN_CONTRAST} is the floor.`,
      );
    }

    return new VisualPlan(palette, [...input.scenes].sort((a, b) => a.sceneIndex - b.sceneIndex));
  }

  /** The neutral fallback: the theme's own colours, no per-scene guidance. */
  public static default(palette: Palette): VisualPlan {
    return new VisualPlan(palette, []);
  }

  public forScene(index: number): ScenePlan | undefined {
    return this.scenes.find((s) => s.sceneIndex === index);
  }

  /**
   * Accents that clear the contrast floor against the ground.
   *
   * Filtered rather than rejected: an accent used for a thin connector is less
   * critical than the ink, so a marginal one is dropped instead of failing the
   * whole plan and losing a good palette over one colour.
   */
  public get legibleAccents(): readonly string[] {
    const usable = this.palette.accents.filter(
      (accent) => contrastRatio(accent, this.palette.ground) >= 3,
    );
    return usable.length > 0 ? usable : [this.palette.ink];
  }

  /**
   * Per-video overrides for the theme's CSS custom properties.
   *
   * Every colour token the theme defines is redefined here, and every accent
   * slot is filled. Leaving one out does not fall back to something neutral — it
   * leaves the *theme's* colour in place, so a scene referencing
   * `var(--ink-accent-3)` under a two-accent plan would paint with a colour from
   * outside the video's palette, and `--ink-secondary` would keep a mid-grey
   * that may be invisible on a plan's chosen ground.
   */
  public toCssVariables(): string {
    const accents = this.legibleAccents;
    const lines = [
      `--board-bg: ${this.palette.ground};`,
      `--ink-primary: ${this.palette.ink};`,
      `--ink-secondary: ${this.secondary};`,
      `--ink-muted: ${this.palette.muted};`,
      `--ink-accent: ${accents[0]};`,
    ];

    // Every slot the theme might have defined, cycling rather than leaving gaps.
    for (let slot = 1; slot <= ACCENT_SLOTS; slot += 1) {
      lines.push(`--ink-accent-${slot}: ${accents[(slot - 1) % accents.length]};`);
    }
    return lines.join('\n  ');
  }

  /**
   * Supporting text: the ink, eased toward the ground.
   *
   * Derived rather than asked for, because a planner given one more colour to
   * choose tends to pick one that fights the ink. Blending guarantees it sits
   * between ink and ground on whatever ground was chosen, so it reads on a dark
   * palette as well as a light one.
   */
  private get secondary(): string {
    return mix(this.palette.ink, this.palette.ground, 0.3);
  }
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

export function contrastRatio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

/** Linear blend in sRGB. `amount` is how far from `a` toward `b`. */
function mix(a: string, b: string, amount: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const from = parseInt(a.slice(offset, offset + 2), 16);
    const to = parseInt(b.slice(offset, offset + 2), 16);
    return Math.round(from + (to - from) * amount);
  });
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
