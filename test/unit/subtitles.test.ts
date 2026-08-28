import { describe, it, expect } from 'vitest';
import { SubtitleSegmentationPolicy } from '@domain/policy/SubtitleSegmentationPolicy.js';
import { WordTiming } from '@domain/media/WordTiming.js';
import { FfmpegAssembler } from '@infrastructure/encode/FfmpegAssembler.js';
import { SubtitleCue } from '@domain/media/SubtitleCue.js';
import { Duration } from '@domain/shared/Duration.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const policy = new SubtitleSegmentationPolicy({
  maxCharsPerLine: 42, maxLines: 2, minCueDurationMs: 900,
  maxCueDurationMs: 6000, interCueGapMs: 80,
});

const words = (text: string, msEach = 300): WordTiming[] =>
  text.split(' ').map((w, i) => WordTiming.of(w, i * msEach, (i + 1) * msEach));

describe('subtitle segmentation', () => {
  it('keeps every input word, in order, across all cues', () => {
    const text = 'Photosynthesis converts light energy into chemical energy stored in glucose molecules for later use';
    const cues = policy.segment(words(text));
    expect(cues.flatMap((c) => c.text.split(/\s+/)).join(' ')).toBe(text);
  });

  it('never splits a word across a line', () => {
    const cues = policy.segment(words('antidisestablishmentarianism is a very long word indeed here'));
    for (const cue of cues) {
      for (const line of cue.lines) expect(line).not.toMatch(/^\S*-$/);
    }
  });

  it('handles a single word longer than a full cue', () => {
    const cues = policy.segment([WordTiming.of('supercalifragilisticexpialidociousandthensome'.repeat(2), 0, 1000)]);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.lines.length).toBeGreaterThan(0);
  });

  it('starts the first cue at the first word', () => {
    expect(policy.segment(words('a b c'))[0]!.start.ms).toBe(0);
  });

  it('produces cues that never run backwards', () => {
    const cues = policy.segment(words('one two three four five six seven eight nine ten eleven twelve'));
    for (const cue of cues) expect(cue.end.ms).toBeGreaterThan(cue.start.ms);
  });

  it('respects a non-zero start index for multi-scene numbering', () => {
    const first = policy.segment(words('a b c d e f'), 1);
    const second = policy.segment(words('g h i j k l'), first.length + 1);
    expect(second[0]!.index).toBe(first.length + 1);
  });
});

describe('SRT serialisation', () => {
  it('writes the format players expect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'srt-'));
    const path = join(dir, 'out.srt');

    await new FfmpegAssembler().writeSubtitles([
      SubtitleCue.of(1, Duration.fromMs(0), Duration.fromMs(2500), ['First line', 'second line']),
      SubtitleCue.of(2, Duration.fromMs(2600), Duration.fromMs(5000), ['Third']),
    ], path);

    const srt = await readFile(path, 'utf8');
    expect(srt).toContain('1\r\n00:00:00,000 --> 00:00:02,500\r\nFirst line\r\nsecond line');
    expect(srt).toContain('2\r\n00:00:02,600 --> 00:00:05,000\r\nThird');
    // Blank line between cues is what separates them.
    expect(srt).toMatch(/second line\r\n\r\n2/);

    await rm(dir, { recursive: true, force: true });
  });

  it('uses comma for milliseconds, not a period', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'srt2-'));
    const path = join(dir, 'out.srt');
    await new FfmpegAssembler().writeSubtitles(
      [SubtitleCue.of(1, Duration.fromMs(3661500), Duration.fromMs(3663000), ['x'])], path,
    );
    expect(await readFile(path, 'utf8')).toContain('01:01:01,500 --> 01:01:03,000');
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * Regression: the greedy wrap truncated to `maxLines` and discarded whatever
 * did not fit, so a cue whose text wrapped to three lines silently lost its
 * third line. Subtitles that drop words are worse than no subtitles — the
 * viewer cannot tell they are incomplete.
 */
describe('subtitle segmentation never loses words', () => {
  const realistic = [
    'Photosynthesis is the process by which green plants, algae and some bacteria convert light energy into chemical energy stored in glucose.',
    'The light-dependent reactions occur in the thylakoid membrane, where chlorophyll absorbs photons most strongly in the blue and red regions.',
    'Protons flowing back down that gradient through the enzyme ATP synthase drive the production of ATP, a process called photophosphorylation.',
    'a b c d e f g h i j k l m n o p q r s t u v w x y z',
    'supercalifragilistic expialidocious antidisestablishmentarianism pneumonoultramicroscopicsilicovolcanoconiosis',
  ];

  it.each(realistic)('preserves every word of: %s', (text) => {
    const timings = text.split(' ').map((w, i) => WordTiming.of(w, i * 320, (i + 1) * 320));
    const cues = policy.segment(timings);

    expect(cues.flatMap((c) => c.lines.join(' ').split(/\s+/)).join(' ')).toBe(text);
  });

  it('never emits a cue that needs more lines than configured', () => {
    for (const text of realistic) {
      const timings = text.split(' ').map((w, i) => WordTiming.of(w, i * 320, (i + 1) * 320));
      for (const cue of policy.segment(timings)) {
        expect(cue.lines.length, text).toBeLessThanOrEqual(2);
      }
    }
  });
});
