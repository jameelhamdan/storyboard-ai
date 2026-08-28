import type { RenderSegment } from '@application/port/SceneRendererPort.js';
import type { Storyboard } from '@domain/script/Storyboard.js';

/**
 * Splits a job's frame range so each segment renders and retries independently.
 *
 * Segments align to scene boundaries wherever possible: a segment that straddles
 * a scene has to load two scenes' HTML, and a retry then redraws both. Scene-
 * aligned segments also make a failed segment diagnosable — it names the scene.
 */
export function planSegments(storyboard: Storyboard, maxSegments: number): readonly RenderSegment[] {
  const windows = storyboard.windows;
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
