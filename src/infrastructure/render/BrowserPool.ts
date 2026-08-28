import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { LoggerPort } from '@application/port/LoggerPort.js';

export interface BrowserPoolOptions {
  /**
   * Path to a Chromium binary. `playwright-core` ships no browsers, which is
   * deliberate: the worker image installs Debian's `chromium` package instead of
   * downloading one, so the build pulls from Debian rather than a vendor CDN.
   */
  readonly executablePath?: string;
  /** Fallback viewport. Callers that know the job's preset should pass their own. */
  readonly width: number;
  readonly height: number;
}

/**
 * One browser per worker process, one page per segment.
 *
 * Launching Chromium costs a second or more, and a job renders several segments,
 * so the browser outlives any single render and is torn down with the process.
 * Pages are cheap by comparison and are not shared — a page carries the scene's
 * document and its seek state, and two segments seeking the same page would race.
 *
 * The flags below exist for determinism, not speed: the same frame must render
 * identically on any worker, or the chaos/resume path silently produces a video
 * whose replaced segment does not match its neighbours.
 */
export class BrowserPool {
  private browser: Browser | undefined;
  private launching: Promise<Browser> | undefined;

  constructor(
    private readonly options: BrowserPoolOptions,
    private readonly logger: LoggerPort,
  ) {}

  /**
   * A page sized to the frame it will produce.
   *
   * The viewport must match the job's preset, not the pool's default: the
   * renderer screenshots an explicit clip at the preset's dimensions, and
   * Chromium silently clamps a clip to the viewport rather than erroring. A
   * `vertical` job on a 1280x720 viewport came out 720x720 — cropped, with
   * nothing in the logs to say so.
   */
  public async page(viewport?: { width: number; height: number }): Promise<Page> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: {
        width: viewport?.width ?? this.options.width,
        height: viewport?.height ?? this.options.height,
      },
      deviceScaleFactor: 1,
      // The page is self-contained; a locale-dependent default would change
      // number and date rendering between machines.
      locale: 'en-GB',
      timezoneId: 'UTC',
      reducedMotion: 'reduce',
      colorScheme: 'light',
    });

    const page = await context.newPage();

    // Nothing in a scene document may reach the network. The sanitiser is the
    // first line of defence and this is the second: if a URL slips past it, the
    // request still fails rather than leaking that a render happened.
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('about:')) return route.continue();
      this.logger.warn({ url: url.slice(0, 120) }, 'scene document attempted an outbound request');
      return route.abort();
    });

    return page;
  }

  public async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    this.launching = undefined;
    if (browser) await browser.close().catch(() => undefined);
  }

  /** Concurrent segments share one launch rather than racing several. */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= this.launch();
    this.browser = await this.launching;
    return this.browser;
  }

  private async launch(): Promise<Browser> {
    /**
     * CHROMIUM_PATH is the container's path, and the same .env is read on a
     * developer's machine where it does not exist. Falling back to whatever
     * Playwright can find beats failing every scene preview with
     * "executable doesn't exist" — the images still set it and still win.
     */
    const configured = this.options.executablePath;
    const executablePath = configured && existsSync(configured) ? configured : undefined;
    if (configured && !executablePath) {
      this.logger.warn({ configured }, 'CHROMIUM_PATH does not exist here; using Playwright\'s own browser');
    }

    const browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: [
        // Rendering must not vary with the host GPU.
        '--disable-gpu',
        '--disable-lcd-text',
        '--force-color-profile=srgb',
        '--font-render-hinting=none',
        '--disable-font-subpixel-positioning',
        // The container has a small /dev/shm; without this Chromium crashes
        // under concurrent contexts rather than degrading.
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--mute-audio',
      ],
    });
    this.logger.info({ version: browser.version() }, 'chromium launched');
    return browser;
  }
}
