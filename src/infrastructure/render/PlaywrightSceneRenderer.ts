import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright-core';
import type {
  SceneRendererPort, RenderSegment, RenderedSegment,
} from '@application/port/SceneRendererPort.js';
import type { Storyboard } from '@domain/script/Storyboard.js';
import type { Scene } from '@domain/script/Scene.js';
import type { SceneWindow } from '@domain/script/Storyboard.js';
import type { Theme } from '@domain/media/Theme.js';
import type { VisualPlan } from '@domain/media/VisualPlan.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import { FfmpegRunner } from '../encode/FfmpegRunner.js';
import { planSegments } from './SegmentPlanner.js';
import { scheduleFrames, toConcatList, transitionProgress } from './FrameSchedule.js';
import { buildSceneDocument } from './page/document.js';
import type { BrowserPool } from './BrowserPool.js';

/**
 * Renders scenes in a browser: seek, screenshot, encode.
 *
 * It knows nothing about components. A scene arrives as HTML, the page lays it
 * out, and the renderer captures pixels — which is what lets the storyboard
 * author invent any diagram it likes without the renderer growing a case for it.
 * The previous renderer understood two of thirteen classes and silently dropped
 * the rest; this one has nothing to drop.
 *
 * Only frames that differ are rendered. `scheduleFrames` decides which those are
 * and how long each covers, and the ffmpeg concat demuxer stretches the stills —
 * roughly 65 screenshots for a two-minute video rather than 3,144.
 */
export class PlaywrightSceneRenderer implements SceneRendererPort {
  constructor(
    private readonly theme: Theme,
    private readonly browsers: BrowserPool,
    private readonly logger: LoggerPort,
    private readonly ffmpeg: FfmpegRunner = new FfmpegRunner(),
  ) {}

  public planSegments(storyboard: Storyboard, maxSegments: number): readonly RenderSegment[] {
    return planSegments(storyboard, maxSegments);
  }

  public async renderSegment(input: {
    storyboard: Storyboard;
    segment: RenderSegment;
    outputPath: string;
    visualPlan?: VisualPlan;
    signal?: AbortSignal;
  }): Promise<RenderedSegment> {
    const startedAt = Date.now();
    const { storyboard, segment } = input;
    const { preset } = storyboard;

    const scheduleOptions = {
      revealMs: this.theme.tokens.motion.revealMs,
      fps: preset.fps,
      transitionMs: SCENE_TRANSITION_MS,
    };
    const schedule = scheduleFrames(storyboard, segment, scheduleOptions);

    if (schedule.length === 0) {
      throw new Error(`Segment ${segment.index} scheduled no frames; it covers no time.`);
    }

    const framesDir = join(dirname(input.outputPath), `frames-${segment.index}`);
    await mkdir(framesDir, { recursive: true });

    const page = await this.browsers.page({ width: preset.width, height: preset.height });
    try {
      let currentScene: number | undefined;

      for (const entry of schedule) {
        if (input.signal?.aborted) throw new Error('Cancelled during render.');

        const window = windowFor(storyboard, entry.frame);
        if (!window) continue;
        const scene = storyboard.scenes[window.sceneIndex];
        if (!scene) continue;

        // Reloading the document per frame would dominate the cost; it only
        // changes when the segment crosses into a different scene.
        if (currentScene !== window.sceneIndex) {
          await this.loadScene(page, scene, preset.width, preset.height, input.visualPlan);
          currentScene = window.sceneIndex;
        }

        // Scene-relative, because reveal times are stored relative to the scene.
        const sceneMs = ((entry.frame - window.startFrame) / preset.fps) * 1000;
        await page.evaluate(`window.__seekTo(${sceneMs})`);

        /**
         * The cross-fade at a scene boundary.
         *
         * Driven from Node rather than from a CSS transition for the same
         * reason as everything else here: a transition advances against the
         * wall clock, so two renders of the same frame would differ. The
         * opacity is a pure function of the frame number.
         */
        const fade = transitionProgress(storyboard, entry.frame, scheduleOptions);
        await page.evaluate(`window.__setTransition(${fade ?? 1})`);

        await page.screenshot({
          path: framePath(framesDir, entry.frame),
          type: 'png',
          // Explicit clip rather than fullPage: a scene that overflows must be
          // cropped to the frame, not silently change the video's dimensions.
          clip: { x: 0, y: 0, width: preset.width, height: preset.height },
        });
      }

      await this.encode(framesDir, schedule, input.outputPath, preset, input.signal);
    } finally {
      await page.context().close().catch(() => undefined);
      // Frames are large and trivially regenerated, so they are never kept.
      await rm(framesDir, { recursive: true, force: true }).catch(() => undefined);
    }

    const wallSeconds = (Date.now() - startedAt) / 1000;
    this.logger.debug({
      segment: segment.index,
      renders: schedule.length,
      frames: segment.endFrame - segment.startFrame,
      wallSeconds,
    }, 'segment rendered');

    return {
      index: segment.index,
      path: input.outputPath,
      frameCount: segment.endFrame - segment.startFrame,
      wallSeconds,
    };
  }

  private async loadScene(
    page: Page, scene: Scene, width: number, height: number, visualPlan?: VisualPlan,
  ): Promise<void> {
    const html = buildSceneDocument({
      scene, theme: this.theme, width, height, ...(visualPlan ? { visualPlan } : {}),
    });
    // `domcontentloaded` rather than `load`: there is nothing external to wait
    // for, and `load` would sit until the blocked requests time out.
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
  }

  private async encode(
    framesDir: string,
    schedule: readonly { frame: number; holdFrames: number }[],
    outputPath: string,
    preset: { fps: number; width: number; height: number; crf: number },
    signal?: AbortSignal,
  ): Promise<void> {
    const listPath = join(framesDir, 'frames.txt');
    await writeFile(listPath, toConcatList(schedule, (f) => framePath(framesDir, f), preset.fps), 'utf8');

    await this.ffmpeg.run([
      '-f', 'concat', '-safe', '0', '-i', listPath,
      // The concat list carries per-image durations, so the input is variable
      // frame rate; `-fps_mode cfr` resamples it back to the preset's fixed
      // rate, which is what the assembler expects when it concatenates
      // segments. (`-vsync`, its old spelling, is deprecated in ffmpeg 7.)
      '-fps_mode', 'cfr',
      '-r', String(preset.fps),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', String(preset.crf),
      '-pix_fmt', 'yuv420p',
      '-y', outputPath,
    ], signal);
  }
}

/**
 * Cross-fade length at a scene boundary.
 *
 * Short on purpose. Every frame it spans has to be drawn individually — a
 * boundary costs roughly 2 x fps x (ms/1000) renders where a hard cut cost
 * none — so this trades a measurable slice of render time for the single
 * clearest signal that a video was edited rather than assembled.
 */
const SCENE_TRANSITION_MS = 180;

function framePath(dir: string, frame: number): string {
  return join(dir, `f${String(frame).padStart(6, '0')}.png`);
}

/** The scene that owns a given absolute frame. */
function windowFor(storyboard: Storyboard, frame: number): SceneWindow | undefined {
  for (const window of storyboard.windows) {
    if (frame >= window.startFrame && frame < window.endFrame) return window;
  }
  // Frames in the inter-scene gap belong to the scene that just ended, so the
  // board holds rather than going blank.
  let last: SceneWindow | undefined;
  for (const window of storyboard.windows) {
    if (window.startFrame <= frame) last = window;
  }
  return last;
}
