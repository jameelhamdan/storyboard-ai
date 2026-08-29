import type { RenderSegment } from '@application/port/SceneRendererPort.js';
import type { Storyboard } from '@domain/script/Storyboard.js';

/**
 * Splits a job's frame range so each segment renders and retries independently.
 *
 * Segments align to **board** boundaries, not scene boundaries.
 *
 * A board is one document loaded once and seeked across its whole span, so a
 * segment that split a board mid-build would load the same page twice and — more
 * to the point — would cut in the middle of a diagram that is still being drawn.
 * Board-aligned segments cut only where the video already cuts, which is also
 * the only place a cross-fade happens. A failed segment still names the scenes
 * it covers, because a board carries them.
 */
export function planSegments(storyboard: Storyboard, maxSegments: number): readonly RenderSegment[] {
  const windows = storyboard.boardWindows;
  if (windows.length === 0) return [];

  const total = storyboard.totalFrames;
  if (total === 0) return [];

  // Fewer scenes than workers: one segment per scene, and some workers idle.
  if (windows.length <= maxSegments) {
    return windows.map((window, index) => ({
      index,
      startFrame: window.startFrame,
      endFrame: index === windows.length - 1 ? total : windows[index + 1]!.startFrame,
    })).filter((s) => s.endFrame > s.startFrame);
  }

  // More scenes than workers: group whole scenes into roughly equal frame budgets.
  const perSegment = Math.ceil(total / maxSegments);
  const segments: RenderSegment[] = [];
  let startFrame = 0;
  let index = 0;

  for (let i = 0; i < windows.length; i += 1) {
    const isLast = i === windows.length - 1;
    const endFrame = isLast ? total : windows[i + 1]!.startFrame;

    if (endFrame - startFrame >= perSegment || isLast) {
      if (endFrame > startFrame) {
        segments.push({ index, startFrame, endFrame });
        index += 1;
      }
      startFrame = endFrame;
    }
  }

  return segments;
}
