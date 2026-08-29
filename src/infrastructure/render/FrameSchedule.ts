import type { RenderSegment } from '@application/port/SceneRendererPort.js';
import type { Storyboard } from '@domain/script/Storyboard.js';

/**
 * One rendered image and how long it stays on screen.
 *
 * `frame` is the absolute frame to seek to; `holdFrames` is how many frames that
 * single image covers — always at least 1.
 */
export interface ScheduledFrame {
  readonly frame: number;
  readonly holdFrames: number;
}

export interface FrameScheduleOptions {
  /** How long a reveal takes to play out, from `theme.motion.revealMs`. */
  readonly revealMs: number;
  readonly fps: number;
  /**
   * Cross-fade length at a **board** boundary. Those frames genuinely differ
   * from each other, so they have to be drawn — unlike a still stretch, which
   * one render covers. Zero keeps the previous hard-cut behaviour and its cost.
   *
   * Board, not scene: a wipe says "new diagram". Inside a board the diagram
   * persists and is added to, so fading there would throw away the continuity
   * the board exists to provide.
   */
  readonly transitionMs?: number;
  /**
   * How long an element takes to recede once its step has passed. Those frames
   * differ too, so the schedule has to draw each of them.
   */
  readonly stepDimMs?: number;
}

/**
 * Decides which frames actually have to be rendered.
 *
 * The whiteboard style rule is that nothing moves after it arrives, so all but a
 * handful of frames are pixel-identical to the one before them. Rendering all of
 * them would mean ~3,000 screenshots for a two-minute video to produce ~10
 * distinct images.
 *
 * So: render every frame inside a reveal window, and exactly one frame for each
 * still stretch between windows. A 131-second video with nine reveals drops from
 * 3,144 renders to roughly 65.
 *
 * The invariant the caller depends on — and the tests assert — is that
 * `sum(holdFrames)` equals the segment's frame count exactly. If it drifts, the
 * segment's duration drifts with it and the video desyncs from its audio.
 */
export function scheduleFrames(
  storyboard: Storyboard,
  segment: RenderSegment,
  options: FrameScheduleOptions,
): readonly ScheduledFrame[] {
  const total = segment.endFrame - segment.startFrame;
  if (total <= 0) return [];

  const { animated, breakpoints } = collectChangeFrames(storyboard, segment, options);

  const schedule: ScheduledFrame[] = [];
  let frame = segment.startFrame;

  while (frame < segment.endFrame) {
    if (animated.has(frame)) {
      // Mid-reveal: this frame differs from its neighbours, so it is drawn alone.
      schedule.push({ frame, holdFrames: 1 });
      frame += 1;
      continue;
    }

    // A still stretch, held until something animates or a new scene starts.
    // A scene boundary only *breaks* the run — it does not force a frame of its
    // own, which would spend a render to draw the same still twice.
    let next = frame + 1;
    while (next < segment.endFrame && !animated.has(next) && !breakpoints.has(next)) next += 1;
    schedule.push({ frame, holdFrames: next - frame });
    frame = next;
  }

  return schedule;
}

/**
 * The board's opacity at a frame, or undefined when it is not in a transition.
 *
 * **Only one scene's document is ever loaded**, so this cannot be a true A/B
 * cross-dissolve — it is a dip: the outgoing board fades down to the background,
 * and the incoming one fades up from it.
 *
 * That distinction was the bug. This used to return `(delta + frames) / (frames
 * * 2)`, a straight 0 → 1 ramp described as "the incoming scene's opacity" — but
 * `windowFor` hands the renderer the *outgoing* scene for every frame before the
 * boundary, so that half of the ramp faded the outgoing board *up* from fully
 * invisible. The board vanished and then reappeared, which is the opposite of a
 * fade out.
 *
 * Opacity is therefore a function of the distance from the boundary, not of the
 * signed offset: 1 at either end of the window, 0 at the boundary itself.
 */
export function transitionProgress(
  storyboard: Storyboard, frame: number, options: FrameScheduleOptions,
): number | undefined {
  const frames = Math.max(0, Math.round(((options.transitionMs ?? 0) / 1000) * options.fps));
  if (frames === 0) return undefined;

  for (const window of storyboard.boardWindows) {
    if (window.boardIndex === 0) continue; // nothing to fade from
    const delta = frame - window.startFrame;
    if (delta >= -frames && delta <= frames) {
      return Math.abs(delta) / frames;
    }
  }
  return undefined;
}

/**
 * The two kinds of frame that matter.
 *
 * `animated` — mid-reveal, so distinct from its neighbours and rendered alone.
 * A reveal at `t` plays over `revealMs`, so `t` through `t + revealMs` inclusive
 * all differ.
 *
 * `breakpoints` — a new scene begins, so a still run must not continue across
 * it. The board changes, but a single render still covers the frames after it.
 *
 * Reveals are stored per scene and relative to that scene's start, so they are
 * offset by the scene's window before being compared against absolute frames.
 */
function collectChangeFrames(
  storyboard: Storyboard,
  segment: RenderSegment,
  options: FrameScheduleOptions,
): { animated: ReadonlySet<number>; breakpoints: ReadonlySet<number> } {
  const animated = new Set<number>();
  const breakpoints = new Set<number>();
  const revealFrames = Math.max(1, Math.round((options.revealMs / 1000) * options.fps));
  const transitionFrames = Math.max(
    0, Math.round(((options.transitionMs ?? 0) / 1000) * options.fps),
  );

  /**
   * Cross-fade frames first, and deliberately over *every* boundary rather than
   * only the ones strictly inside this segment.
   *
   * `transitionProgress` reports a partial opacity for any frame within the
   * fade window of any boundary, and it knows nothing about segments. So this
   * set has to cover exactly the same frames, or the two disagree — and they
   * did. Segments are scene-aligned by construction (`planSegments`), so a
   * boundary sitting *on* `segment.startFrame` is the normal case, not an edge
   * case: the old `> segment.startFrame` guard meant those frames were never
   * marked animated, the first frame of the segment was rendered as a still at
   * `--scene-opacity: 0.5`, and that half-faded board was then held for the
   * whole run until the next reveal.
   *
   * The frames before a boundary belong to the outgoing scene and land in the
   * previous segment; the frames after belong to the incoming one. Clipping to
   * the segment is what assigns each to whichever segment draws it.
   */
  for (const window of storyboard.boardWindows) {
    if (window.boardIndex === 0) continue; // nothing to fade from
    for (let offset = -transitionFrames; offset <= transitionFrames; offset += 1) {
      const absolute = window.startFrame + offset;
      if (absolute >= segment.startFrame && absolute < segment.endFrame) {
        animated.add(absolute);
      }
    }
  }

  /**
   * A step change is a change in the picture even when nothing new is revealed.
   *
   * When a step ends, everything in it recedes — over `stepDimMs`, and every one
   * of those frames differs from the last. Without this the schedule would hold
   * one still across the whole transition and the focus would appear to jump,
   * which is precisely the cue the build exists to give. The first scene of a
   * board starts no dim, having nothing behind it.
   */
  const dimFrames = Math.max(0, Math.round(((options.stepDimMs ?? 0) / 1000) * options.fps));
  if (dimFrames > 0) {
    for (const board of storyboard.boards) {
      for (const scene of board.scenes.slice(1)) {
        const window = storyboard.windowFor(scene.index);
        if (!window) continue;
        breakpoints.add(window.startFrame);
        for (let offset = 0; offset <= dimFrames; offset += 1) {
          const absolute = window.startFrame + offset;
          if (absolute >= segment.startFrame && absolute < segment.endFrame) {
            animated.add(absolute);
          }
        }
      }
    }
  }

  for (const window of storyboard.windows) {
    // Scenes wholly outside this segment contribute nothing.
    if (window.endFrame <= segment.startFrame || window.startFrame >= segment.endFrame) continue;

    const scene = storyboard.scenes[window.sceneIndex];
    if (!scene) continue;

    // A boundary strictly inside the segment breaks a still run: the board
    // changes, though a single render still covers the frames after it.
    if (window.startFrame > segment.startFrame && window.startFrame < segment.endFrame) {
      breakpoints.add(window.startFrame);
    }

    for (const reveal of scene.timeline.reveals) {
      const at = window.startFrame + reveal.at.toFrames(options.fps);
      for (let offset = 0; offset <= revealFrames; offset += 1) {
        const absolute = at + offset;
        if (absolute >= segment.startFrame && absolute < segment.endFrame) {
          animated.add(absolute);
        }
      }
    }
  }

  return { animated, breakpoints };
}

/**
 * The ffmpeg concat-demuxer list for a schedule.
 *
 * Each entry names an image and how long it shows. The final entry is repeated
 * without a duration because the demuxer ignores the last `duration` directive —
 * a documented quirk that otherwise drops the closing frames.
 */
export function toConcatList(
  schedule: readonly ScheduledFrame[],
  fileFor: (frame: number) => string,
  fps: number,
): string {
  if (schedule.length === 0) return '';

  const lines: string[] = [];
  for (const entry of schedule) {
    lines.push(`file '${fileFor(entry.frame).replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${(entry.holdFrames / fps).toFixed(6)}`);
  }

  const last = schedule[schedule.length - 1]!;
  lines.push(`file '${fileFor(last.frame).replace(/'/g, "'\\''")}'`);

  return `${lines.join('\n')}\n`;
}
