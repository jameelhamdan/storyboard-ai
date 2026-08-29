import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BoardPreviewPort, BoardPreview } from '@application/port/ScenePreviewPort.js';
import type { Board } from '@domain/script/Board.js';
import type { Theme } from '@domain/media/Theme.js';
import type { VisualPlan } from '@domain/media/VisualPlan.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import { buildBoardDocument } from './page/document.js';
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
export class PlaywrightScenePreviewer implements BoardPreviewPort {
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
    board: Board;
    outputPathFor: (step: number) => string;
    visualPlan?: VisualPlan;
    width?: number;
    height?: number;
    minFontRem?: number;
    signal?: AbortSignal;
  }): Promise<BoardPreview> {
    const width = input.width ?? this.width;
    const height = input.height ?? this.height;
    const nothing: BoardPreview = { paths: [], layoutFailures: [] };
    const { board } = input;

    if (!board.html) return nothing;
    if (input.signal?.aborted) return nothing;

    try {
      const page = await this.browsers.page({ width, height });
      try {
        const html = buildBoardDocument({
          board,
          theme: this.theme,
          width,
          height,
          ...(input.visualPlan ? { visualPlan: input.visualPlan } : {}),
        });
        await page.setContent(html, { waitUntil: 'domcontentloaded' });

        /**
         * Measured once, at the settled end of the build.
         *
         * Every element is visible there, so this is the strictest state the
         * board ever reaches — and it is the *only* one worth measuring, since a
         * step toggles visibility without touching layout. A collision that does
         * not exist here cannot appear at an earlier step.
         */
        await page.evaluate(`window.__seekTo(${PlaywrightScenePreviewer.SETTLED_MS})`);
        const minFontPx = (input.minFontRem ?? this.theme.tokens.type.minRem) * 16;
        const layoutFailures = (await page.evaluate(
          measureScript(width, height, minFontPx),
        )) as string[];

        /**
         * One frame per step, each at the moment that step finishes.
         *
         * Seeked one millisecond before the next step begins, so the frame shows
         * that step complete and still in focus rather than already receding.
         * The last step has no successor and is photographed settled.
         */
        const paths: string[] = [];
        for (let step = 1; step <= board.steps; step += 1) {
          if (input.signal?.aborted) break;

          const next = board.scenes[step];
          const at = next
            ? Math.max(0, board.offsetOf(next.index).ms - 1)
            : PlaywrightScenePreviewer.SETTLED_MS;

          await page.evaluate(`window.__seekTo(${at})`);

          const outputPath = input.outputPathFor(step);
          await mkdir(dirname(outputPath), { recursive: true });
          await page.screenshot({
            path: outputPath,
            type: 'png',
            clip: { x: 0, y: 0, width, height },
          });
          paths.push(outputPath);
        }

        return { paths, layoutFailures };
      } finally {
        await page.context().close().catch(() => undefined);
      }
    } catch (error) {
      this.logger.warn(
        { sceneIndexes: board.sceneIndexes, err: error },
        'board preview failed; judging from markup alone',
      );
      return nothing;
    }
  }
}
