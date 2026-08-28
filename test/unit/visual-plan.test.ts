import { describe, it, expect } from 'vitest';
import { VisualPlan, contrastRatio } from '@domain/media/VisualPlan.js';

const palette = (over: Partial<{
  ground: string; ink: string; accents: string[]; muted: string;
}> = {}) => ({
  ground: '#FFFFFF', ink: '#1F2933',
  accents: ['#2B6CB0', '#B7791F'], muted: '#9AA5B1',
  ...over,
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white, in either order', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 1);
  });

  it('is 1:1 for a colour against itself', () => {
    expect(contrastRatio('#2B6CB0', '#2B6CB0')).toBeCloseTo(1, 5);
  });
});

describe('VisualPlan palette validation', () => {
  it('accepts a well-formed palette', () => {
    expect(() => VisualPlan.of({ palette: palette(), scenes: [] })).not.toThrow();
  });

  it('rejects an unreadable palette rather than poisoning every scene', () => {
    // A palette applies to the whole video, so a low-contrast one is not a bad
    // scene — it is a bad video. Better to fall back to the theme.
    expect(() => VisualPlan.of({ palette: palette({ ink: '#EEEEEE' }), scenes: [] }))
      .toThrow(/contrast/i);
  });

  it('names the offending role when a colour is not hex', () => {
    expect(() => VisualPlan.of({ palette: palette({ muted: 'grey' }), scenes: [] }))
      .toThrow(/muted/);
    expect(() => VisualPlan.of({ palette: palette({ accents: ['#2B6CB0', 'blue'] }), scenes: [] }))
      .toThrow(/accents\[1\]/);
  });

  it('requires between one and four accents', () => {
    expect(() => VisualPlan.of({ palette: palette({ accents: [] }), scenes: [] })).toThrow(/accents/);
    expect(() => VisualPlan.of({
      palette: palette({ accents: ['#111111', '#222222', '#333333', '#444444', '#555555'] }),
      scenes: [],
    })).toThrow(/accents/);
  });
});

describe('VisualPlan accents', () => {
  it('drops accents that would be invisible on the ground', () => {
    // Filtered rather than rejected: one weak accent should not lose an
    // otherwise good palette.
    const plan = VisualPlan.of({
      palette: palette({ accents: ['#2B6CB0', '#FDFDFD'] }),
      scenes: [],
    });
    expect(plan.legibleAccents).toEqual(['#2B6CB0']);
  });

  it('falls back to the ink when no accent is legible', () => {
    const plan = VisualPlan.of({ palette: palette({ accents: ['#FEFEFE'] }), scenes: [] });
    expect(plan.legibleAccents).toEqual(['#1F2933']);
  });

  it('emits one numbered custom property per legible accent', () => {
    const css = VisualPlan.of({ palette: palette(), scenes: [] }).toCssVariables();
    expect(css).toContain('--ink-accent: #2B6CB0;');
    expect(css).toContain('--ink-accent-1: #2B6CB0;');
    expect(css).toContain('--ink-accent-2: #B7791F;');
    expect(css).toContain('--board-bg: #FFFFFF;');
  });

  it('fills every accent slot, so no theme colour leaks through', () => {
    // An unfilled slot does not fall back to something neutral — it leaves the
    // *theme's* accent in place, and a scene using var(--ink-accent-3) would
    // then paint with a colour from outside this video's palette.
    const css = VisualPlan.of({ palette: palette({ accents: ['#2B6CB0'] }), scenes: [] })
      .toCssVariables();
    for (const slot of [1, 2, 3, 4]) {
      expect(css, `slot ${slot}`).toContain(`--ink-accent-${slot}: #2B6CB0;`);
    }
  });

  it('cycles through the accents it has rather than leaving gaps', () => {
    const css = VisualPlan.of({ palette: palette({ accents: ['#2B6CB0', '#B7791F'] }), scenes: [] })
      .toCssVariables();
    expect(css).toContain('--ink-accent-3: #2B6CB0;');
    expect(css).toContain('--ink-accent-4: #B7791F;');
  });

  it('redefines every colour token the theme sets', () => {
    // Anything omitted keeps the theme's value, which may not belong with the
    // plan's ground at all.
    const css = VisualPlan.of({ palette: palette(), scenes: [] }).toCssVariables();
    for (const token of ['--board-bg', '--ink-primary', '--ink-secondary', '--ink-muted', '--ink-accent']) {
      expect(css, token).toContain(`${token}:`);
    }
  });

  it('derives a secondary that sits between the ink and the ground', () => {
    const css = VisualPlan.of({
      palette: palette({ ink: '#000000', ground: '#FFFFFF' }), scenes: [],
    }).toCssVariables();
    // 30% of the way from black to white.
    expect(css).toContain('--ink-secondary: #4D4D4D;');
  });

  it('keeps the secondary readable on a dark ground', () => {
    // The failure this prevents: a mid-grey secondary inherited from a
    // light-ground theme, invisible on a dark palette.
    const plan = VisualPlan.of({
      palette: palette({ ink: '#F5F5F5', ground: '#101418' }), scenes: [],
    });
    const secondary = /--ink-secondary: (#[0-9A-F]{6});/.exec(plan.toCssVariables())?.[1];
    expect(secondary).toBeDefined();
    expect(contrastRatio(secondary!, '#101418')).toBeGreaterThan(4.5);
  });
});

describe('VisualPlan scenes', () => {
  it('orders scenes by index regardless of how the model returned them', () => {
    const plan = VisualPlan.of({
      palette: palette(),
      scenes: [
        { sceneIndex: 2, concept: 'c', emphasis: [] },
        { sceneIndex: 0, concept: 'a', emphasis: [] },
        { sceneIndex: 1, concept: 'b', emphasis: [] },
      ],
    });
    expect(plan.scenes.map((s) => s.sceneIndex)).toEqual([0, 1, 2]);
  });

  it('looks a scene up by index', () => {
    const plan = VisualPlan.of({
      palette: palette(),
      scenes: [{ sceneIndex: 3, concept: 'a cycle', emphasis: ['citrate'] }],
    });
    expect(plan.forScene(3)?.concept).toBe('a cycle');
    expect(plan.forScene(9)).toBeUndefined();
  });

  it('has no per-scene guidance in the neutral fallback', () => {
    const plan = VisualPlan.default(palette());
    expect(plan.scenes).toEqual([]);
    expect(plan.forScene(0)).toBeUndefined();
  });
});
