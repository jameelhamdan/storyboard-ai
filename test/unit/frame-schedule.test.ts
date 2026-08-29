import { describe, it, expect } from 'vitest';
import { scheduleFrames, toConcatList } from '@infrastructure/render/FrameSchedule.js';
import { planSegments } from '@infrastructure/render/SegmentPlanner.js';
import { Storyboard } from '@domain/script/Storyboard.js';
import { Scene } from '@domain/script/Scene.js';
import { SceneTimeline } from '@domain/script/SceneTimeline.js';
import { Duration } from '@domain/shared/Duration.js';
import { WordTiming } from '@domain/media/WordTiming.js';
import { QualityPreset } from '@domain/media/QualityPreset.js';
import { Citation } from '@domain/content/Citation.js';
import { SourceRef } from '@domain/content/SourceRef.js';

const FPS = 24;
const preset = QualityPreset.of({
  name: 'standard', width: 1280, height: 720, fps: FPS, codec: 'h264', crf: 23,
});

const OPTIONS = { revealMs: 260, fps: FPS };

/**
 * A scene whose reveals land at the given millisecond offsets.
 *
 * Built through the real `SceneTimeline.resolve()` path rather than by
 * fabricating reveals: word timings are synthesised so each anchor phrase
 * resolves to the intended moment. That way the fixture exercises the same
 * resolution the pipeline uses, and cannot drift from it.
 */
const scene = (index: number, ms: number, revealsAtMs: number[] = []) => {
  const words = revealsAtMs.map((_, i) => `anchor${i}`);
  const base = Scene.of({
    index,
    spokenText: `scene ${index} ${words.join(' ')} narration text`,
    citations: [Citation.of(`c${index}`, [SourceRef.page('doc', index + 1)])],
    visualIntent: 'focus',
    estimatedDuration: Duration.fromMs(ms),
  });
  if (revealsAtMs.length === 0) return base;

  const anchors = revealsAtMs.map((_, i) => ({
    elementId: `s${index}-p${i}`, phrase: words[i]!, draw: 'normal' as const,
  }));
  const timings = revealsAtMs.map((at, i) =>
    WordTiming.of(words[i]!, at, at + 200));

  return base.withStoryboard(
    '<section class="sc-scene"></section>',
    SceneTimeline.unresolved(anchors).resolve(timings),
  );
};

const board = (scenes: Scene[]) => Storyboard.of(scenes, preset, Duration.zero());

/** The invariant everything else depends on. */
const totalHeld = (s: readonly { holdFrames: number }[]) =>
  s.reduce((t, e) => t + e.holdFrames, 0);

describe('scheduleFrames', () => {
  it('covers the segment exactly — held frames sum to its length', () => {
    const storyboard = board([scene(0, 4000, [500, 1500, 2500])]);
    const [segment] = planSegments(storyboard, 6);
    const schedule = scheduleFrames(storyboard, segment!, OPTIONS);

    expect(totalHeld(schedule)).toBe(segment!.endFrame - segment!.startFrame);
  });

  it('holds a single still for a scene with no reveals', () => {
    // Nothing animates, so one image covers the whole scene.
    const storyboard = board([scene(0, 4000)]);
    const [segment] = planSegments(storyboard, 6);
    const schedule = scheduleFrames(storyboard, segment!, OPTIONS);

    expect(schedule).toHaveLength(1);
    expect(schedule[0]!.frame).toBe(segment!.startFrame);
    expect(totalHeld(schedule)).toBe(segment!.endFrame - segment!.startFrame);
  });

  it('renders far fewer frames than the segment contains', () => {
    // The whole point: three reveals in four seconds should not cost 96 renders.
    const storyboard = board([scene(0, 4000, [500, 1500, 2500])]);
    const [segment] = planSegments(storyboard, 6);
    const schedule = scheduleFrames(storyboard, segment!, OPTIONS);

    const frameCount = segment!.endFrame - segment!.startFrame;
    expect(schedule.length).toBeLessThan(frameCount / 2);
    expect(schedule.length).toBeGreaterThan(3);
  });

  it('emits consecutive single frames through a reveal window', () => {
    const storyboard = board([scene(0, 4000, [1000])]);
    const [segment] = planSegments(storyboard, 6);
    const schedule = scheduleFrames(storyboard, segment!, OPTIONS);

    // revealMs 260 at 24fps ≈ 6 frames, plus the frame the reveal starts on.
    const animated = schedule.filter((e) => e.holdFrames === 1);
    expect(animated.length).toBeGreaterThanOrEqual(7);
  });

  it('never emits a frame outside the segment', () => {
    const storyboard = board([scene(0, 2000, [500]), scene(1, 2000, [500]), scene(2, 2000, [500])]);
    for (const segment of planSegments(storyboard, 3)) {
      for (const entry of scheduleFrames(storyboard, segment, OPTIONS)) {
        expect(entry.frame).toBeGreaterThanOrEqual(segment.startFrame);
        expect(entry.frame).toBeLessThan(segment.endFrame);
      }
    }
  });

  it('produces strictly increasing, non-overlapping entries', () => {
    const storyboard = board([scene(0, 5000, [400, 1200, 3000])]);
    const [segment] = planSegments(storyboard, 6);
    const schedule = scheduleFrames(storyboard, segment!, OPTIONS);

    for (let i = 1; i < schedule.length; i += 1) {
      const previous = schedule[i - 1]!;
      expect(schedule[i]!.frame).toBe(previous.frame + previous.holdFrames);
    }
  });

  it('covers every segment exactly when a job is split across many', () => {
    // Segment boundaries are where an off-by-one turns into audio drift.
    const storyboard = board([
      scene(0, 3000, [500]), scene(1, 3000, [500, 1500]),
      scene(2, 3000, []), scene(3, 3000, [2000]),
    ]);
    const segments = planSegments(storyboard, 2);
    let covered = 0;
    for (const segment of segments) {
      const schedule = scheduleFrames(storyboard, segment, OPTIONS);
      expect(totalHeld(schedule)).toBe(segment.endFrame - segment.startFrame);
      covered += totalHeld(schedule);
    }
    expect(covered).toBe(storyboard.totalFrames);
  });

  it('always renders the frame a scene begins on', () => {
    // The board changes at a scene boundary even with no reveals.
    const storyboard = board([scene(0, 2000), scene(1, 2000)]);
    const segments = planSegments(storyboard, 1);
    const schedule = scheduleFrames(storyboard, segments[0]!, OPTIONS);
    const sceneTwoStart = storyboard.windows[1]!.startFrame;

    expect(schedule.some((e) => e.frame === sceneTwoStart)).toBe(true);
  });

  it('returns nothing for an empty segment', () => {
    const storyboard = board([scene(0, 1000)]);
    expect(scheduleFrames(storyboard, { index: 0, startFrame: 5, endFrame: 5 }, OPTIONS)).toEqual([]);
  });

  it('is deterministic — the same inputs schedule identically', () => {
    // The chaos test re-renders a segment on a different worker and expects the
    // same output; a schedule that varied would break that silently.
    const storyboard = board([scene(0, 4000, [500, 1500])]);
    const [segment] = planSegments(storyboard, 6);
    expect(scheduleFrames(storyboard, segment!, OPTIONS))
      .toEqual(scheduleFrames(storyboard, segment!, OPTIONS));
  });
});

describe('toConcatList', () => {
  it('repeats the final file, because the demuxer ignores the last duration', () => {
    const list = toConcatList(
      [{ frame: 0, holdFrames: 24 }, { frame: 24, holdFrames: 12 }],
      (f) => `/tmp/f${f}.png`,
      FPS,
    );
    const lines = list.trim().split('\n');
    expect(lines[lines.length - 1]).toBe("file '/tmp/f24.png'");
    expect(lines.filter((l) => l.startsWith('file ')).length).toBe(3);
  });

  it('writes durations in seconds', () => {
    const list = toConcatList([{ frame: 0, holdFrames: 24 }], (f) => `/tmp/f${f}.png`, FPS);
    expect(list).toContain('duration 1.000000');
  });

  it('escapes single quotes in paths', () => {
    const list = toConcatList([{ frame: 0, holdFrames: 1 }], () => "/tmp/it's/f.png", FPS);
    expect(list).toContain("'\\''");
  });

  it('returns nothing for an empty schedule', () => {
    expect(toConcatList([], (f) => `${f}.png`, FPS)).toBe('');
  });
});
