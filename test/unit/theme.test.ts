import { describe, it, expect } from 'vitest';
import { loadConfig } from '@interfaces/config/loadConfig.js';
import { Theme } from '@domain/media/Theme.js';
import { testEnv } from '../helpers/env.js';

/**
 * docs/whiteboard-style.md promises the look is defined entirely by tokens, so it
 * can be retuned without touching a component. That only holds while the renderer
 * reads them — it previously restated the exact hex values inline.
 */
describe('Theme', () => {
  const config = loadConfig(testEnv());

  it('loads both presets named in theme.yaml', () => {
    expect([...config.resolved.themes.keys()].sort()).toEqual(['crisp', 'standard']);
  });

  it('resolves inheritance so a variant states only its deltas', () => {
    const standard = config.resolved.themes.get('standard')!;
    const crisp = config.resolved.themes.get('crisp')!;

    // crisp overrides only stroke.jitter and type.family in theme.yaml.
    expect(crisp.tokens.ink.primary).toBe(standard.tokens.ink.primary);
    expect(crisp.tokens.type.family).not.toBe(standard.tokens.type.family);
  });

  it('exposes the legibility floor Stage A gates on', () => {
    expect(config.resolved.defaultTheme.tokens.type.minRem).toBeGreaterThan(0);
    expect(config.resolved.legibility.minContrastRatio).toBe(4.5);
  });

  /**
   * whiteboard-style.md promises the look is retuned by editing theme.yaml and
   * nothing else. That is only true for tokens that actually reach the page —
   * seven of them were schema-validated and then dropped in loadConfig, so the
   * document promised control the renderer never had.
   */
  it('emits every token the stylesheet reads', () => {
    const css = config.resolved.defaultTheme.toCssVariables();

    for (const variable of [
      '--board-bg', '--board-padding', '--board-vignette',
      '--ink-primary', '--ink-secondary', '--ink-accent', '--ink-muted',
      '--type-family', '--type-title', '--type-body', '--type-label',
      '--type-min', '--type-line-height', '--type-letter-spacing',
      '--stroke-width', '--stroke-linecap', '--stroke-jitter', '--stroke-radius',
      '--motion-reveal-ms', '--motion-stagger-ms', '--motion-ease',
      '--motion-draw-ms-per-100px',
    ]) {
      expect(css, `${variable} never reaches the page`).toContain(`${variable}:`);
    }
  });

  it('resolves the pen geometry rather than defaulting it away', () => {
    const { stroke, motion, board } = config.resolved.defaultTheme.tokens;

    expect(stroke.widthPx).toBeGreaterThan(0);
    expect(stroke.linecap).toBeTruthy();
    expect(motion.ease).toMatch(/cubic-bezier/);
    expect(['none', 'subtle']).toContain(board.vignette);
  });

  it('rejects a colour that is not a hex triplet', () => {
    const valid = config.resolved.defaultTheme.tokens;
    expect(() => Theme.of('bad', { ...valid, ink: { ...valid.ink, primary: 'red' } }))
      .toThrow(/hex colour/);
  });

  it('rejects a non-positive legibility floor', () => {
    const valid = config.resolved.defaultTheme.tokens;
    expect(() => Theme.of('bad', { ...valid, type: { ...valid.type, minRem: 0 } }))
      .toThrow(/legibility floor/);
  });
});
