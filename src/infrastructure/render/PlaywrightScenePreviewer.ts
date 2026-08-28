import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ScenePreviewPort, ScenePreview } from '@application/port/ScenePreviewPort.js';
import type { Scene } from '@domain/script/Scene.js';
import type { Theme } from '@domain/media/Theme.js';
import type { VisualPlan } from '@domain/media/VisualPlan.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import { buildSceneDocument } from './page/document.js';
import { measureScript } from './page/measure.js';
import type { BrowserPool } from './BrowserPool.js';

/**
 * A single frame of a scene, taken after every reveal has landed, plus what the
 * laid-out page can be asked about directly.
 *
 * Seeking past the end rather than to a specific time is deliberate: the judge
 * is asked whether the finished scene reads well, not whether it animates well,
 * so it should see the state a viewer holds on — everything present and settled.
 *
 * Never throws. A scene that cannot be previewed is judged from its markup
 * alone, which is worse but not fatal; failing here would turn a screenshot
 * problem into a rejected scene.
 */
export class PlaywrightScenePreviewer implements ScenePreviewPort {
  /** Comfortably past any scene's last reveal. */
  private static readonly SETTLED_MS = 600_000;

  constructor(
    private readonly theme: Theme,
    private readonly browsers: BrowserPool,
    private readonly logger: LoggerPort,
    private readonly width = 1280,
    private readonly height = 720,
  ) {}

  public async capture(input: {
    scene: Scene;
    outputPath: string;
    visualPlan?: VisualPlan;
    width?: number;
    height?: number;
    minFontRem?: number;
    signal?: AbortSignal;
  }): Promise<ScenePreview> {
    const width = input.width ?? this.width;
    const height = input.height ?? this.height;
    const nothing: ScenePreview = { path: undefined, layoutFailures: [] };

    if (!input.scene.html) return nothing;
    if (input.signal?.aborted) return nothing;

    try {
      await mkdir(dirname(input.outputPath), { recursive: true });
      const page = await this.browsers.page({ width, height });
      try {
        const html = buildSceneDocument({
          scene: input.scene,
          theme: this.theme,
          width,
          height,
          ...(input.visualPlan ? { visualPlan: input.visualPlan } : {}),
        });
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        await page.evaluate(`window.__seekTo(${PlaywrightScenePreviewer.SETTLED_MS})`);

        // Measured from the same settled page that is about to be photographed,
        // so the numbers describe the image rather than some other state of it.
        const minFontPx = (input.minFontRem ?? this.theme.tokens.type.minRem) * 16;
        const layoutFailures = (await page.evaluate(
          measureScript(width, height, minFontPx),
        )) as string[];

        await page.screenshot({
          path: input.outputPath,
          type: 'png',
          clip: { x: 0, y: 0, width, height },
        });
        return { path: input.outputPath, layoutFailures };
      } finally {
        await page.context().close().catch(() => undefined);
      }
    } catch (error) {
      this.logger.warn(
        { sceneIndex: input.scene.index, err: error },
        'scene preview failed; judging from markup alone',
      );
      return nothing;
    }
  }
}
