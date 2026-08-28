import { describe, it, expect } from 'vitest';
import { planSegments } from '@infrastructure/render/SegmentPlanner.js';
import { Storyboard } from '@domain/script/Storyboard.js';
import { Scene } from '@domain/script/Scene.js';
import { Duration } from '@domain/shared/Duration.js';
import { QualityPreset } from '@domain/media/QualityPreset.js';
import { Citation } from '@domain/content/Citation.js';
import { SourceRef } from '@domain/content/SourceRef.js';

const preset = QualityPreset.of({ name: 'standard', width: 1280, height: 720, fps: 24, codec: 'h264', crf: 23 });

const scene = (index: number, ms: number) => Scene.of({
  index,
  spokenText: `scene ${index} narration text`,
  citations: [Citation.of(`c${index}`, [SourceRef.page('doc', index + 1)])],
  visualIntent: 'focus',
  estimatedDuration: Duration.fromMs(ms),
});

const board = (durations: number[], gapMs = 0) =>
  Storyboard.of(durations.map((ms, i) => scene(i, ms)), preset, Duration.fromMs(gapMs));

describe('SegmentPlanner', () => {
  it('returns nothing for an empty storyboard', () => {
    expect(planSegments(board([]), 4)).toEqual([]);
  });

  it('covers the entire frame range with no gaps and no overlaps', () => {
    const b = board([1000, 2000, 1500, 3000, 500], 350);
    const segments = planSegments(b, 3);

    expect(segments[0]!.startFrame).toBe(0);
    expect(segments.at(-1)!.endFrame).toBe(b.totalFrames);

    for (let i = 0; i < segments.length - 1; i += 1) {
      expect(segments[i]!.endFrame).toBe(segments[i + 1]!.startFrame);
    }
  });

  it('never emits an empty segment', () => {
    for (const count of [1, 2, 3, 5, 9, 17]) {
      const b = board(Array.from({ length: count }, () => 800), 100);
      for (const s of planSegments(b, 4)) {
        expect(s.endFrame, `count=${count}`).toBeGreaterThan(s.startFrame);
      }
    }
  });

  it('numbers segments contiguously from zero', () => {
    const segments = planSegments(board([1000, 1000, 1000, 1000, 1000], 0), 3);
    expect(segments.map((s) => s.index)).toEqual(segments.map((_, i) => i));
  });

  it('gives one segment per scene when scenes are scarcer than workers', () => {
    expect(planSegments(board([1000, 1000], 0), 8)).toHaveLength(2);
  });

  it('does not exceed the worker cap when scenes are plentiful', () => {
    const b = board(Array.from({ length: 40 }, () => 1000), 0);
    expect(planSegments(b, 4).length).toBeLessThanOrEqual(4);
  });

  it('handles a single scene', () => {
    const segments = planSegments(board([5000], 0), 4);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ startFrame: 0, endFrame: 120 });
  });

  it('handles scenes whose duration rounds to zero frames', () => {
    const segments = planSegments(board([1, 1, 1], 0), 2);
    for (const s of segments) expect(s.endFrame).toBeGreaterThan(s.startFrame);
  });
});

describe('Storyboard windows', () => {
  it('places the first scene at zero', () => {
    expect(board([1000, 1000], 350).windowFor(0)!.start.ms).toBe(0);
  });

  it('inserts the gap between scenes but not after the last', () => {
    const b = board([1000, 1000], 350);
    expect(b.windowFor(1)!.start.ms).toBe(1350);
    expect(b.totalDuration.ms).toBe(2350);
  });

  it('keeps frame boundaries consistent with times', () => {
    const b = board([1000, 2000], 0);
    for (const w of b.windows) {
      expect(w.startFrame).toBe(w.start.toFrames(preset.fps));
      expect(w.endFrame).toBe(w.end.toFrames(preset.fps));
    }
  });

  it('returns undefined for an unknown scene index', () => {
    expect(board([1000], 0).windowFor(99)).toBeUndefined();
  });
});
