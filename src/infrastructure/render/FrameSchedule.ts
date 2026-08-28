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
   * Cross-fade length at a scene boundary. Those frames genuinely differ from
   * each other, so they have to be drawn — unlike a still stretch, which one
   * render covers. Zero keeps the previous hard-cut behaviour and its cost.
   */
  readonly transitionMs?: number;
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
 * How far into a cross-fade a frame sits, or undefined when it is not in one.
 *
 * Returns 0..1 for the *incoming* scene's opacity, so the renderer can hand it
 * straight to `__setTransition`.
 */
export function transitionProgress(
  storyboard: Storyboard, frame: number, options: FrameScheduleOptions,
): number | undefined {
  const frames = Math.max(0, Math.round(((options.transitionMs ?? 0) / 1000) * options.fps));
  if (frames === 0) return undefined;

  for (const window of storyboard.windows) {
    if (window.sceneIndex === storyboard.windows[0]?.sceneIndex) continue; // nothing to fade from
    const delta = frame - window.startFrame;
    if (delta >= -frames && delta <= frames) {
      // -frames -> 0 (previous scene fully opaque), +frames -> 1 (new scene in).
      return (delta + frames) / (frames * 2);
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

  for (const window of storyboard.windows) {
    // Scenes wholly outside this segment contribute nothing.
    if (window.endFrame <= segment.startFrame || window.startFrame >= segment.endFrame) continue;

    const scene = storyboard.scenes[window.sceneIndex];
    if (!scene) continue;

    if (window.startFrame > segment.startFrame && window.startFrame < segment.endFrame) {
      breakpoints.add(window.startFrame);

      /**
       * A cross-fade spans the boundary: the outgoing scene fades out over the
       * frames before it and the incoming one fades in over the frames after.
       * Every one of those is a distinct image, so each is drawn individually.
       */
      for (let offset = -transitionFrames; offset <= transitionFrames; offset += 1) {
        const absolute = window.startFrame + offset;
        if (absolute >= segment.startFrame && absolute < segment.endFrame) {
          animated.add(absolute);
        }
      }
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
