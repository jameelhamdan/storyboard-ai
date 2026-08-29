import { describe, it, expect } from 'vitest';
import { buildSceneDocument } from '@infrastructure/render/page/document.js';
import { scheduleFrames, transitionProgress } from '@infrastructure/render/FrameSchedule.js';
import { Scene } from '@domain/script/Scene.js';
import { SceneTimeline } from '@domain/script/SceneTimeline.js';
import { Storyboard } from '@domain/script/Storyboard.js';
import { Theme } from '@domain/media/Theme.js';
import { Duration } from '@domain/shared/Duration.js';
import { QualityPreset } from '@domain/media/QualityPreset.js';
import { WordTiming, resolvePhrase } from '@domain/media/WordTiming.js';
import { Citation } from '@domain/content/Citation.js';
import { SourceRef } from '@domain/content/SourceRef.js';

const preset = QualityPreset.of({ name: 'standard', width: 1280, height: 720, fps: 24, codec: 'h264', crf: 23 });

const theme = Theme.of('standard', {
  board: { background: '#FFFFFF', paddingRem: 4, vignette: 'subtle' },
  stroke: { widthPx: 3, linecap: 'round', jitter: 0.4, cornerRadiusPx: 12 },
  ink: { primary: '#1F2933', secondary: '#52606D', accent: '#2B6CB0', accents: ['#2B6CB0', '#B7791F'], muted: '#9AA5B1' },
  type: { family: "'Kalam', cursive", titleRem: 3.2, bodyRem: 2, labelRem: 1.6, minRem: 1.4, lineHeight: 1.35, letterSpacingEm: 0 },
  motion: { drawMsPer100px: 180, revealMs: 260, staggerMs: 90, ease: 'cubic-bezier(0.22, 1, 0.36, 1)' },
});

const sceneWith = (html: string, anchors: Parameters<typeof SceneTimeline.unresolved>[0], timings: WordTiming[] = []) =>
  Scene.of({
    index: 0,
    spokenText: 'glycolysis splits glucose into pyruvate',
    citations: [Citation.of('c0', [SourceRef.page('doc', 1)])],
    visualIntent: 'parts',
    estimatedDuration: Duration.fromMs(6000),
  }).withStoryboard(html, SceneTimeline.unresolved(anchors).resolve(timings));

const doc = (scene: Scene) =>
  buildSceneDocument({ scene, theme, width: 1280, height: 720 });

/**
 * The storyboard model has always chosen a draw speed per element, and the page
 * never received it — every reveal played at one global duration. These pin the
 * attributes the seek script reads, because a missing one degrades silently
 * into "everything animates identically" rather than into an error.
 */
describe('reveal attributes reaching the page', () => {
  const anchors = [
    { elementId: 'a', phrase: 'glycolysis', draw: 'slow' as const, hold: true },
    { elementId: 'b', phrase: 'splits', draw: 'fast' as const, hold: false },
  ];
  const timings = [
    WordTiming.of('glycolysis', 0, 400),
    WordTiming.of('splits', 400, 700),
  ];

  it('stamps each element with its own draw speed', () => {
    const html = doc(sceneWith('<div id="a">A</div><div id="b">B</div>', anchors, timings));

    expect(html).toMatch(/id="a"[^>]*data-draw-speed="slow"/);
    expect(html).toMatch(/id="b"[^>]*data-draw-speed="fast"/);
  });

  it('stamps a stagger index on elements sharing a moment, not on the first', () => {
    // Both anchor to the same word, so they resolve to the same millisecond.
    const together = [
      { elementId: 'a', phrase: 'glycolysis', draw: 'normal' as const, hold: false },
      { elementId: 'b', phrase: 'glycolysis', draw: 'normal' as const, hold: false },
    ];
    const html = doc(sceneWith('<div id="a">A</div><div id="b">B</div>', together, timings));

    expect(html).not.toMatch(/id="a"[^>]*data-stagger-index/);
    expect(html).toMatch(/id="b"[^>]*data-stagger-index="1"/);
  });

  it('carries the motion tokens the seek script reads off the root element', () => {
    const html = doc(sceneWith('<div id="a">A</div>', anchors.slice(0, 1), timings));

    expect(html).toContain('data-stagger-ms="90"');
    expect(html).toContain('data-vignette="subtle"');
    expect(html).toContain('--motion-ease: cubic-bezier(0.22, 1, 0.36, 1)');
  });

  it('handles a self-closing tag without swallowing the slash', () => {
    const html = doc(sceneWith('<svg><path id="a" d="M0 0 H10"/></svg>', anchors.slice(0, 1), timings));
    expect(html).toMatch(/id="a"[^>]*data-reveal-at="0"[^>]*\/>/);
  });
});

/**
 * A cross-fade is the one animation here that is not free: every frame it spans
 * is a distinct image. These pin that the cost is bounded and that the fade is
 * a pure function of the frame, which is what keeps a re-rendered segment
 * identical to the one it replaces.
 */
describe('scene transitions', () => {
  const board = () => Storyboard.of(
    [0, 1].map((i) => Scene.of({
      index: i,
      spokenText: `scene ${i}`,
      citations: [Citation.of(`c${i}`, [SourceRef.page('doc', i + 1)])],
      visualIntent: 'focus',
      estimatedDuration: Duration.fromMs(2000),
    })),
    preset,
    Duration.zero(),
  );

  const options = { revealMs: 260, fps: 24, transitionMs: 180 };

  /**
   * A dip, not a ramp. Only one scene's document is loaded at a time, so the
   * outgoing board fades *down* to the background and the incoming one fades up
   * from it. A monotonic 0 → 1 ramp across the boundary would apply the low half
   * to the outgoing scene, fading it up from invisible instead of out.
   */
  it('dips to the background at a boundary and is undefined away from one', () => {
    const b = board();
    const boundary = b.windows[1]!.startFrame;

    expect(transitionProgress(b, boundary - 20, options)).toBeUndefined();
    // Fully faded out exactly on the boundary...
    expect(transitionProgress(b, boundary, options)).toBeCloseTo(0, 5);
    // ...and fully opaque at both ends of the window.
    expect(transitionProgress(b, boundary - 4, options)).toBeCloseTo(1, 5);
    expect(transitionProgress(b, boundary + 4, options)).toBeCloseTo(1, 5);
    // Monotonic on each side, so the outgoing board darkens rather than brightens.
    expect(transitionProgress(b, boundary - 3, options)!)
      .toBeLessThan(transitionProgress(b, boundary - 4, options)!);
    expect(transitionProgress(b, boundary + 3, options)!)
      .toBeLessThan(transitionProgress(b, boundary + 4, options)!);
  });

  /**
   * The regression this pair exists for.
   *
   * `planSegments` aligns segments to scene boundaries, so a boundary sitting on
   * `segment.startFrame` is the normal case. The schedule used to skip those
   * fade frames while `transitionProgress` still reported a partial opacity for
   * them, so the segment's first frame was rendered half-faded and then *held*
   * as a still for the whole run.
   */
  it('renders every frame it reports an opacity for, including at a segment start', () => {
    const b = board();
    const boundary = b.windows[1]!.startFrame;
    const segment = { index: 1, startFrame: boundary, endFrame: b.totalFrames };

    const drawn = new Set(scheduleFrames(b, segment, options).map((f) => f.frame));

    for (let frame = segment.startFrame; frame < segment.endFrame; frame += 1) {
      if (transitionProgress(b, frame, options) !== undefined) {
        expect(drawn.has(frame)).toBe(true);
      }
    }
  });

  it('never holds a partially-faded frame as a still', () => {
    const b = board();
    const boundary = b.windows[1]!.startFrame;
    const segment = { index: 1, startFrame: boundary, endFrame: b.totalFrames };

    for (const entry of scheduleFrames(b, segment, options)) {
      const fade = transitionProgress(b, entry.frame, options);
      // A frame mid-dip may only ever cover itself.
      if (fade !== undefined && fade < 1) expect(entry.holdFrames).toBe(1);
    }
  });

  it('is deterministic — the same frame always yields the same opacity', () => {
    const boundary = board().windows[1]!.startFrame;
    const a = transitionProgress(board(), boundary + 2, options);
    const c = transitionProgress(board(), boundary + 2, options);
    expect(a).toBe(c);
  });

  it('renders the fade frames individually but still covers the segment exactly', () => {
    const b = board();
    const segment = { index: 0, startFrame: 0, endFrame: b.totalFrames };

    const withFade = scheduleFrames(b, segment, options);
    const hardCut = scheduleFrames(b, segment, { ...options, transitionMs: 0 });

    // The invariant the whole pipeline depends on: holds sum to the frame count.
    const covered = withFade.reduce((total, f) => total + f.holdFrames, 0);
    expect(covered).toBe(segment.endFrame - segment.startFrame);

    // And the fade genuinely costs renders, so the tradeoff stays visible.
    expect(withFade.length).toBeGreaterThan(hardCut.length);
  });

  it('costs nothing when transitions are off', () => {
    const b = board();
    const segment = { index: 0, startFrame: 0, endFrame: b.totalFrames };
    expect(scheduleFrames(b, segment, { revealMs: 260, fps: 24 }).length)
      .toBe(scheduleFrames(b, segment, { ...options, transitionMs: 0 }).length);
  });
});

/**
 * Anchors resolve against word timings. When those timings are *recovered* by
 * transcribing synthesized audio rather than aligned against the input text, a
 * mishearing used to drop the anchor entirely — the element then inherited the
 * previous one's time and several reveals bunched onto one moment.
 */
describe('anchor resolution tolerates imperfect timings', () => {
  const timings = [
    WordTiming.of('glycolysis', 0, 400),
    WordTiming.of('splits', 400, 700),
    WordTiming.of('glucose', 700, 1100),
  ];

  it('still prefers an exact match', () => {
    expect(resolvePhrase('splits glucose', timings)?.ms).toBe(400);
  });

  it('falls back to the leading run when a later word came back wrong', () => {
    // The transcriber heard "pyruvate" as something else; the phrase still
    // begins at "glucose", which is where the element should appear.
    expect(resolvePhrase('glucose molecules', timings)?.ms).toBe(700);
  });

  it('anchors to where the phrase starts, never to a later matching word', () => {
    // "splits" appears mid-phrase; anchoring there would reveal early.
    expect(resolvePhrase('glycolysis splits', timings)?.ms).toBe(0);
  });

  it('refuses to anchor a multi-word phrase on a single common word', () => {
    // One word out of four is not evidence; inheriting is better than anchoring
    // the whole element to an unrelated moment.
    expect(resolvePhrase('the other glucose pathway entirely', [
      WordTiming.of('unrelated', 0, 100),
      WordTiming.of('glucose', 100, 200),
    ])).toBeUndefined();
  });

  it('still returns undefined when nothing matches at all', () => {
    expect(resolvePhrase('mitochondrial membrane', timings)).toBeUndefined();
  });
});
