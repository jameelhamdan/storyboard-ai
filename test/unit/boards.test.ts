import { describe, it, expect } from 'vitest';
import { Board, groupIntoBoards } from '@domain/script/Board.js';
import { Scene } from '@domain/script/Scene.js';
import { SceneDiagram } from '@domain/script/SceneDiagram.js';
import { SceneTimeline } from '@domain/script/SceneTimeline.js';
import { Storyboard } from '@domain/script/Storyboard.js';
import { buildBoardDocument } from '@infrastructure/render/page/document.js';
import { renderDiagram } from '@infrastructure/render/diagram/renderDiagram.js';
import { planSegments } from '@infrastructure/render/SegmentPlanner.js';
import { scheduleFrames, transitionProgress } from '@infrastructure/render/FrameSchedule.js';
import { Theme } from '@domain/media/Theme.js';
import { Duration } from '@domain/shared/Duration.js';
import { QualityPreset } from '@domain/media/QualityPreset.js';
import { WordTiming } from '@domain/media/WordTiming.js';
import { Citation } from '@domain/content/Citation.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import type { DiagramShape } from '@domain/script/DiagramShape.js';

const GAP = Duration.fromMs(350);
const preset = QualityPreset.of({ name: 'standard', width: 1280, height: 720, fps: 24, codec: 'h264', crf: 23 });

const theme = Theme.of('standard', {
  board: { background: '#FFFFFF', paddingRem: 4, vignette: 'none' },
  stroke: { widthPx: 3, linecap: 'round', jitter: 0.4, cornerRadiusPx: 12 },
  ink: { primary: '#1F2933', secondary: '#52606D', accent: '#2B6CB0', accents: ['#2B6CB0', '#B7791F'], muted: '#9AA5B1' },
  type: { family: "'Kalam', cursive", titleRem: 3.2, bodyRem: 2, labelRem: 1.6, minRem: 1.4, lineHeight: 1.35, letterSpacingEm: 0 },
  motion: { drawMsPer100px: 180, revealMs: 260, staggerMs: 90, ease: 'cubic-bezier(0.22, 1, 0.36, 1)' },
});

function scene(index: number, opts: {
  text?: string;
  shape?: DiagramShape;
  continues?: boolean;
  ms?: number;
} = {}): Scene {
  return Scene.of({
    index,
    spokenText: opts.text ?? `scene ${index} narration text`,
    citations: [Citation.of(`c${index}`, [SourceRef.page('doc', 1)])],
    visualIntent: opts.shape ?? 'flow',
    estimatedDuration: Duration.fromMs(opts.ms ?? 4000),
    ...(opts.continues ? { continuesBoard: true } : {}),
  });
}

describe('grouping scenes into boards', () => {
  it('keeps a scene that continues the previous one on the same board', () => {
    const boards = groupIntoBoards([
      scene(0),
      scene(1, { continues: true }),
      scene(2, { continues: true }),
    ], GAP);

    expect(boards).toHaveLength(1);
    expect(boards[0]!.steps).toBe(3);
    expect(boards[0]!.sceneIndexes).toEqual([0, 1, 2]);
  });

  /** Nothing precedes it, so there is nothing for it to build on. */
  it('never lets the first scene continue anything', () => {
    const boards = groupIntoBoards([scene(0, { continues: true }), scene(1)], GAP);
    expect(boards).toHaveLength(2);
  });

  /**
   * A board is one diagram. A scene asking to continue a `flow` as a `matrix` is
   * asking for a diagram that does not exist, so the continuation is refused
   * rather than honoured into a board whose markup contradicts its narration.
   */
  it('refuses a continuation that disagrees about the shape', () => {
    const boards = groupIntoBoards([
      scene(0, { shape: 'flow' }),
      scene(1, { shape: 'matrix', continues: true }),
    ], GAP);

    expect(boards).toHaveLength(2);
    expect(boards[1]!.visualIntent).toBe('matrix');
  });

  /** The old behaviour, and still the common one. */
  it('gives every standalone scene its own board', () => {
    const boards = groupIntoBoards([scene(0), scene(1), scene(2)], GAP);
    expect(boards.map((b) => b.steps)).toEqual([1, 1, 1]);
  });

  /**
   * A fallback board is the scene's own diagram, so the continuation it was part
   * of has to break — otherwise the board would claim a step whose markup is a
   * different picture entirely.
   */
  it('breaks the continuation when a scene falls back to its own board', () => {
    const fallen = scene(1, { continues: true })
      .asFallbackComponent('<section id="x"></section>', SceneTimeline.unresolved([]));

    expect(groupIntoBoards([scene(0), fallen], GAP)).toHaveLength(2);
  });
});

describe('a board\'s clock', () => {
  const board = Board.of(0, [
    scene(0, { ms: 4000 }),
    scene(1, { ms: 6000, continues: true }),
    scene(2, { ms: 5000, continues: true }),
  ], GAP);

  it('places each step after the previous one plus the gap', () => {
    expect(board.offsetOf(0).ms).toBe(0);
    expect(board.offsetOf(1).ms).toBe(4350);
    expect(board.offsetOf(2).ms).toBe(10700);
  });

  /** The gap after the last scene belongs to the next board's boundary. */
  it('excludes the trailing gap from its own duration', () => {
    expect(board.duration.ms).toBe(4000 + 350 + 6000 + 350 + 5000);
  });


  /**
   * The join that makes a shared document work. Each scene resolves its anchors
   * against its own timings, which are scene-relative; the page is seeked on the
   * board's clock. Without the offset every step would draw at the time it would
   * have had if its scene started the board.
   */
  it('rebases each scene\'s reveals onto the board\'s clock', () => {
    const withTimings = [
      scene(0, { text: 'alpha beta', ms: 4000 })
        .withStoryboard('<div id="a"></div>', SceneTimeline.unresolved([
          { elementId: 'a', phrase: 'alpha', draw: 'normal', step: 1 },
        ]))
        .withMeasuredAudio(Duration.fromMs(4000), [
          WordTiming.of('alpha', 1000, 1500), WordTiming.of('beta', 1500, 2000),
        ]),
      scene(1, { text: 'gamma delta', ms: 6000, continues: true })
        .withStoryboard('<div id="b"></div>', SceneTimeline.unresolved([
          { elementId: 'b', phrase: 'gamma', draw: 'normal', step: 2 },
        ]))
        .withMeasuredAudio(Duration.fromMs(6000), [
          WordTiming.of('gamma', 500, 900), WordTiming.of('delta', 900, 1400),
        ]),
    ];

    const reveals = Board.of(0, withTimings, GAP).reveals;

    expect(reveals.map((r) => [r.elementId, r.at.ms, r.step])).toEqual([
      ['a', 1000, 1],
      // 4000ms of scene 0 + 350ms gap + 500ms into scene 1.
      ['b', 4850, 2],
    ]);
  });
});

describe('the board document', () => {
  const diagram = SceneDiagram.of({
    shape: 'flow',
    title: 'How it works',
    steps: 2,
    nodes: [
      { id: 'a', label: 'Anode', anchor: 'alpha', step: 1 },
      { id: 'b', label: 'Cathode', anchor: 'gamma', step: 2 },
    ],
    edges: [{ from: 'a', to: 'b', step: 2 }],
  });

  const board = () => {
    const html = renderDiagram(diagram, 0).html;
    const anchors = renderDiagram(diagram, 0).anchors;
    const scenes = [
      scene(0, { text: 'alpha beta', ms: 4000 })
        .withStoryboard(html, SceneTimeline.unresolved(anchors.filter((a) => (a.step ?? 1) === 1))),
      scene(1, { text: 'gamma delta', ms: 6000, continues: true })
        .withStoryboard(html, SceneTimeline.unresolved(anchors.filter((a) => (a.step ?? 1) === 2))),
    ];
    return Board.of(0, scenes, GAP);
  };

  /**
   * The browser cannot know where a step begins — that is the scenes' measured
   * audio, which exists only in Node. Without this the seek script dims nothing
   * and gates nothing, and the build silently becomes a board that arrives whole.
   */
  it('stamps where each step begins', () => {
    expect(buildBoardDocument({ board: board(), theme, width: 1280, height: 720 }))
      .toContain('data-step-starts="0,4350"');
  });

  it('carries the step onto the elements the seek script reads', () => {
    const html = buildBoardDocument({ board: board(), theme, width: 1280, height: 720 });
    expect(html).toMatch(/id="s0-n1"[^>]*data-step="2"/);
  });

  /** A one-step board has nothing behind it, so nothing can recede. */
  it('reduces to a single step for a standalone scene', () => {
    const solo = Board.forScene(
      scene(0).withStoryboard(renderDiagram(
        SceneDiagram.of({ shape: 'focus', title: 'T', nodes: [{ id: 'a', label: 'One idea' }] }), 0,
      ).html, SceneTimeline.unresolved([])),
    );

    const html = buildBoardDocument({ board: solo, theme, width: 1280, height: 720 });
    expect(html).toContain('data-step-starts="0"');
    // Nothing to dim, so nothing is marked — no `data-step` at all.
    expect(html).not.toContain('data-step=');
  });
});

describe('rendering a built board', () => {
  const storyboardOf = (scenes: Scene[]) => Storyboard.of(scenes, preset, GAP);

  /**
   * A segment that split a board mid-build would load the same document twice
   * and cut in the middle of a diagram that is still being drawn.
   */
  it('cuts segments at board boundaries, never between steps', () => {
    const board = storyboardOf([
      scene(0), scene(1, { continues: true }), scene(2, { continues: true }),
      scene(3, { shape: 'tree' }),
    ]);

    const starts = new Set(board.boardWindows.map((w) => w.startFrame));
    for (const segment of planSegments(board, 8)) {
      expect(starts.has(segment.startFrame)).toBe(true);
    }
  });

  /**
   * The wipe means "new diagram". Fading inside a board would throw away exactly
   * the continuity the board exists to provide.
   */
  it('fades only at board boundaries, not at every scene', () => {
    const board = storyboardOf([
      scene(0), scene(1, { continues: true }), scene(2, { shape: 'tree' }),
    ]);
    const options = { revealMs: 260, fps: 24, transitionMs: 180, stepDimMs: 520 };

    const insideBoard = board.windowFor(1)!.startFrame;
    const betweenBoards = board.windowFor(2)!.startFrame;

    expect(transitionProgress(board, insideBoard, options)).toBeUndefined();
    expect(transitionProgress(board, betweenBoards, options)).toBeCloseTo(0, 5);
  });

  /**
   * When a step ends, everything in it recedes over `stepDimMs`, and every one
   * of those frames differs from the last. Holding one still across them would
   * make the focus jump — which is the cue the whole build exists to give.
   */
  it('draws each frame of the dim as the focus moves to the next step', () => {
    const board = storyboardOf([scene(0), scene(1, { continues: true })]);
    const options = { revealMs: 260, fps: 24, transitionMs: 180, stepDimMs: 520 };
    const segment = { index: 0, startFrame: 0, endFrame: board.totalFrames };

    const drawn = scheduleFrames(board, segment, options);
    const stepTwo = board.windowFor(1)!.startFrame;
    const held = new Map(drawn.map((f) => [f.frame, f.holdFrames]));

    // Every frame of the dim ramp is its own render.
    for (let f = stepTwo; f <= stepTwo + Math.round(0.52 * 24); f += 1) {
      expect(held.get(f), `frame ${f}`).toBe(1);
    }
  });

  /** The invariant everything downstream depends on. */
  it('still covers the segment exactly', () => {
    const board = storyboardOf([
      scene(0), scene(1, { continues: true }), scene(2, { shape: 'tree' }),
    ]);
    const options = { revealMs: 260, fps: 24, transitionMs: 180, stepDimMs: 520 };

    for (const segment of planSegments(board, 4)) {
      const covered = scheduleFrames(board, segment, options)
        .reduce((total, f) => total + f.holdFrames, 0);
      expect(covered).toBe(segment.endFrame - segment.startFrame);
    }
  });
});

describe('what a built board may contain', () => {
  const twoStep = (over: Partial<Parameters<typeof SceneDiagram.of>[0]> = {}) =>
    SceneDiagram.of({
      shape: 'flow', title: 'T', steps: 2,
      nodes: [{ id: 'a', label: 'A', step: 1 }, { id: 'b', label: 'B', step: 2 }],
      ...over,
    });

  it('accepts a board whose steps are all occupied', () => {
    expect(twoStep().steps).toBe(2);
  });

  /** A step that draws nothing is a scene the video sits still through. */
  it('rejects a step that adds nothing', () => {
    expect(() => twoStep({
      nodes: [{ id: 'a', label: 'A', step: 1 }, { id: 'b', label: 'B', step: 1 }],
    })).toThrow(/Step 2 .* draws nothing/);
  });

  it('rejects a step outside the board', () => {
    expect(() => twoStep({
      nodes: [{ id: 'a', label: 'A', step: 1 }, { id: 'b', label: 'B', step: 5 }],
    })).toThrow(/outside this board's 1–2/);
  });

  /**
   * The focus is what *moves* as the build advances, so each step gets to name
   * the element the viewer should be looking at while it is spoken.
   */
  it('allows one focal point per step rather than per board', () => {
    expect(() => twoStep({
      nodes: [
        { id: 'a', label: 'A', step: 1, emphasis: true },
        { id: 'b', label: 'B', step: 2, emphasis: true },
      ],
    })).not.toThrow();

    expect(() => SceneDiagram.of({
      shape: 'flow', title: 'T', steps: 2,
      nodes: [
        { id: 'a', label: 'A', step: 1, emphasis: true },
        { id: 'b', label: 'B', step: 1, emphasis: true },
        { id: 'c', label: 'C', step: 2 },
      ],
    })).toThrow(/two focal points/);
  });

  /**
   * The node budget is a layout limit — how much the shape holds without
   * crowding — so it does not grow because the board is narrated over more
   * scenes. The steps decide when elements arrive, not how many there are.
   */
  it('does not raise the node ceiling for a longer build', () => {
    expect(() => SceneDiagram.of({
      shape: 'comparison', title: 'T', steps: 3,
      nodes: [
        { id: 'a', label: 'A', step: 1 }, { id: 'b', label: 'B', step: 2 },
        { id: 'c', label: 'C', step: 3 },
      ],
    })).toThrow(/takes 2–2 nodes/);
  });
});
