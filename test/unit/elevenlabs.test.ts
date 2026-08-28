import { describe, it, expect } from 'vitest';
import {
  wordsFromAlignment,
  alignmentDurationMs,
} from '@infrastructure/speech/ElevenLabsSpeechSynthesizer.js';

/** Builds an alignment as the API returns one: one entry per character. */
const align = (text: string, msPerChar = 100) => ({
  characters: [...text],
  character_start_times_seconds: [...text].map((_, i) => (i * msPerChar) / 1000),
  character_end_times_seconds: [...text].map((_, i) => ((i + 1) * msPerChar) / 1000),
});

describe('ElevenLabs character alignment → word timings', () => {
  it('collapses characters into words on whitespace', () => {
    const words = wordsFromAlignment(align('hi there'));
    expect(words.map((w) => w.word)).toEqual(['hi', 'there']);
  });

  it('spans a word from its first character start to its last character end', () => {
    const [hi, there] = wordsFromAlignment(align('hi there'));
    expect(hi!.start.ms).toBe(0);
    expect(hi!.end.ms).toBe(200);      // 'h'+'i' = 2 chars
    expect(there!.start.ms).toBe(300); // index 3, the space at index 2 carries no word
    expect(there!.end.ms).toBe(800);
  });

  it('never emits a timing for whitespace itself', () => {
    const words = wordsFromAlignment(align('a  b\tc\nd'));
    expect(words.map((w) => w.word)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps punctuation attached, so anchors match the spoken form', () => {
    // Anchors are verbatim substrings of the narration; splitting "glucose."
    // into "glucose" + "." would make the phrase lookup miss.
    const words = wordsFromAlignment(align('makes glucose.'));
    expect(words.map((w) => w.word)).toEqual(['makes', 'glucose.']);
  });

  it('is monotonic — no word starts before the previous one ends', () => {
    const words = wordsFromAlignment(align('one two three four'));
    for (let i = 1; i < words.length; i += 1) {
      expect(words[i]!.start.ms).toBeGreaterThanOrEqual(words[i - 1]!.end.ms);
    }
  });

  it('skips characters with missing timings rather than defaulting them to zero', () => {
    // A truncated alignment should shorten the timeline, not stack words at 0ms
    // — which would reveal every element at once on the first frame.
    const words = wordsFromAlignment({
      characters: ['a', ' ', 'b'],
      character_start_times_seconds: [0],
      character_end_times_seconds: [0.1],
    });
    expect(words.map((w) => w.word)).toEqual(['a']);
  });

  it('returns nothing for empty or whitespace-only alignment', () => {
    expect(wordsFromAlignment(align(''))).toEqual([]);
    expect(wordsFromAlignment(align('   '))).toEqual([]);
  });

  it('handles a trailing word with no following whitespace', () => {
    const words = wordsFromAlignment(align('end'));
    expect(words).toHaveLength(1);
    expect(words[0]!.end.ms).toBe(300);
  });

  it('preserves non-ASCII characters for Spanish output', () => {
    const words = wordsFromAlignment(align('energía solar'));
    expect(words.map((w) => w.word)).toEqual(['energía', 'solar']);
  });
});

describe('duration from alignment', () => {
  it('takes the last character end as the audio duration', () => {
    expect(alignmentDurationMs(align('hi there'))).toBe(800);
  });

  it('returns undefined when there is no alignment to read', () => {
    expect(alignmentDurationMs(null)).toBeUndefined();
    expect(alignmentDurationMs({ character_end_times_seconds: [] })).toBeUndefined();
  });
});
