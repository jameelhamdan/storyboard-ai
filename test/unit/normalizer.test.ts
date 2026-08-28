import { describe, it, expect } from 'vitest';
import { NarrationTextNormalizer } from '@infrastructure/speech/NarrationTextNormalizer.js';

/**
 * Normalisation runs before the storyboard, so its output is what `data-on`
 * anchors are matched against and what the synthesiser speaks. A change here
 * silently moves every anchor.
 */
describe('NarrationTextNormalizer', () => {
  const n = new NarrationTextNormalizer();
  const en = (s: string) => n.normalize(s, 'en');
  const es = (s: string) => n.normalize(s, 'es');

  it('expands percent', () => {
    expect(en('Around 50% of the energy')).toContain('percent');
    expect(en('Around 50% of the energy')).not.toContain('%');
  });

  it('expands symbols in Spanish differently', () => {
    expect(es('Cerca del 50% de la energía')).toContain('por ciento');
  });

  it('expands small integers to words', () => {
    expect(en('There are 3 stages')).toBe('There are three stages.'.replace('.', ''));
  });

  it('leaves large numbers alone', () => {
    expect(en('The year 1937 was pivotal')).toContain('1937');
  });

  it('does not mangle a decimal', () => {
    expect(en('A value of 3.14 applies')).toContain('3.14');
  });

  it('does not mangle a ratio or a date', () => {
    expect(en('a 3:1 ratio')).toContain('3:1');
    expect(en('on 12/05 we met')).toContain('12/05');
  });

  it('expands abbreviations', () => {
    expect(en('See Fig. 3 for detail')).toContain('figure');
    expect(en('e.g. glucose')).toContain('for example');
  });

  it('collapses whitespace and tidies punctuation spacing', () => {
    expect(en('a   b   ,  c')).toBe('a b, c');
  });

  it('is idempotent — running it twice changes nothing further', () => {
    const inputs = [
      'Around 50% of 3 stages, see Fig. 2',
      'The Calvin cycle uses ATP & NADPH',
      'Plain text with nothing to expand',
    ];
    for (const input of inputs) {
      const once = en(input);
      expect(en(once), input).toBe(once);
    }
  });

  it('never returns empty for non-empty input', () => {
    for (const input of ['%', '3', 'Fig.', 'a']) {
      expect(en(input).length, input).toBeGreaterThan(0);
    }
  });

  it('falls back to English rules for an unconfigured language', () => {
    expect(n.normalize('50%', 'de')).toContain('percent');
  });

  /**
   * The property the whole anchor mechanism rests on: every word the storyboard
   * can anchor to must survive into the spoken form, because the anchor is
   * matched against exactly this text.
   */
  it('preserves alphabetic words verbatim', () => {
    const input = 'Photosynthesis converts light energy into chemical energy';
    expect(en(input)).toBe(input);
  });
});
