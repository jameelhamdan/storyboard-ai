import { describe, it, expect } from 'vitest';
import { alignWrittenToSpoken } from '@domain/media/alignWrittenToSpoken.js';
import { WordTiming } from '@domain/media/WordTiming.js';
import { Duration } from '@domain/shared/Duration.js';

const spokenFrom = (text: string, msEach = 400): WordTiming[] =>
  text.split(' ').map((w, i) => WordTiming.of(w, i * msEach, (i + 1) * msEach));

const start = Duration.zero();
const span = (ms: number) => Duration.fromMs(ms);

describe('alignWrittenToSpoken', () => {
  it('is exact when the two forms are identical', () => {
    const text = 'the light reactions produce ATP and NADPH';
    const spoken = spokenFrom(text);
    const aligned = alignWrittenToSpoken(text.split(' '), spoken, start, span(2800));

    expect(aligned.map((t) => t.start.ms)).toEqual(spoken.map((t) => t.start.ms));
  });

  it('keeps exact timings for unchanged words around an expansion', () => {
    // "50%" was spoken as "fifty percent" — one written word, two spoken.
    const written = 'about 50% of the energy'.split(' ');
    const spoken = spokenFrom('about fifty percent of the energy');

    const aligned = alignWrittenToSpoken(written, spoken, start, span(2400));

    // 'about' is spoken word 0, 'of' is spoken word 3 — both must be exact.
    expect(aligned[0]!.start.ms).toBe(spoken[0]!.start.ms);
    expect(aligned[2]!.start.ms).toBe(spoken[3]!.start.ms);
    expect(aligned[4]!.start.ms).toBe(spoken[5]!.start.ms);
  });

  it('places the expanded token inside the span it actually occupies', () => {
    const aligned = alignWrittenToSpoken(
      'about 50% of'.split(' '),
      spokenFrom('about fifty percent of'),
      start, span(1600),
    );
    // '50%' must fall between the end of 'about' and the start of 'of'.
    expect(aligned[1]!.start.ms).toBeGreaterThanOrEqual(400);
    expect(aligned[1]!.end.ms).toBeLessThanOrEqual(1200);
  });

  it('returns one timing per written word, always', () => {
    for (const [written, spoken] of [
      ['a b c', 'a b c'],
      ['a 3 c', 'a three c'],
      ['50% 20% 10%', 'fifty percent twenty percent ten percent'],
      ['nothing matches here', 'completely different words entirely'],
    ] as const) {
      const aligned = alignWrittenToSpoken(written.split(' '), spokenFrom(spoken), start, span(2000));
      expect(aligned, `${written} / ${spoken}`).toHaveLength(written.split(' ').length);
    }
  });

  it('never runs backwards', () => {
    const aligned = alignWrittenToSpoken(
      'the Calvin cycle needs 3 ATP and 2 NADPH per turn'.split(' '),
      spokenFrom('the Calvin cycle needs three ATP and two NADPH per turn'),
      start, span(4400),
    );
    for (let i = 1; i < aligned.length; i += 1) {
      expect(aligned[i]!.start.ms).toBeGreaterThanOrEqual(aligned[i - 1]!.start.ms);
    }
  });

  it('offsets by the scene start when nothing aligns', () => {
    const aligned = alignWrittenToSpoken(
      ['alpha', 'beta'], spokenFrom('gamma delta'), Duration.fromMs(5000), span(1000),
    );
    expect(aligned[0]!.start.ms).toBeGreaterThanOrEqual(5000);
  });

  it('handles empty input on either side', () => {
    expect(alignWrittenToSpoken([], spokenFrom('a b'), start, span(800))).toEqual([]);
    expect(alignWrittenToSpoken(['a', 'b'], [], start, span(800))).toHaveLength(2);
  });

  it('does not match a later repeat of a common word', () => {
    // 'the' appears twice; the first written 'the' must take the first spoken.
    const aligned = alignWrittenToSpoken(
      'the cell and the wall'.split(' '),
      spokenFrom('the cell and the wall'),
      start, span(2000),
    );
    expect(aligned[0]!.start.ms).toBe(0);
    expect(aligned[3]!.start.ms).toBe(1200);
  });

  it('is punctuation- and case-insensitive when matching', () => {
    const aligned = alignWrittenToSpoken(
      'Glucose, ATP.'.split(' '),
      spokenFrom('glucose ATP'),
      start, span(800),
    );
    expect(aligned[0]!.start.ms).toBe(0);
    expect(aligned[1]!.start.ms).toBe(400);
  });
});
