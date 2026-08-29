import { describe, it, expect, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PlaywrightSceneRenderer } from '@infrastructure/render/PlaywrightSceneRenderer.js';
import { PlaywrightScenePreviewer } from '@infrastructure/render/PlaywrightScenePreviewer.js';
import { buildSceneDocument } from '@infrastructure/render/page/document.js';
import { VisualPlan } from '@domain/media/VisualPlan.js';
import { BrowserPool } from '@infrastructure/render/BrowserPool.js';
import { createLogger } from '@infrastructure/observability/logger.js';
import { Storyboard } from '@domain/script/Storyboard.js';
import { Scene } from '@domain/script/Scene.js';
import { Board } from '@domain/script/Board.js';
import { SceneTimeline } from '@domain/script/SceneTimeline.js';
import { Duration } from '@domain/shared/Duration.js';
import { WordTiming } from '@domain/media/WordTiming.js';
import { QualityPreset } from '@domain/media/QualityPreset.js';
import { Theme } from '@domain/media/Theme.js';
import { Citation } from '@domain/content/Citation.js';
import { SourceRef } from '@domain/content/SourceRef.js';

const run = promisify(execFile);

/**
 * Container-only: needs Chromium, which lives in the worker/e2e images rather
 * than on a developer's machine. Skipped elsewhere instead of failing, because
 * a red suite on a laptop trains people to ignore red suites.
 *
 *   docker compose run --rm --entrypoint \
 *     "npx vitest run test/integration --reporter=basic" e2e
 */
const chromium = process.env['CHROMIUM_PATH'];
const available = Boolean(chromium && existsSync(chromium));

const preset = QualityPreset.of({
  name: 'standard', width: 1280, height: 720, fps: 24, codec: 'h264', crf: 23,
});

const theme = Theme.of('standard', {
  board: { background: '#FFFFFF', paddingRem: 4, vignette: 'subtle' },
  stroke: { widthPx: 3, linecap: 'round', jitter: 0.4, cornerRadiusPx: 12 },
  ink: {
    primary: '#1F2933', secondary: '#52606D', accent: '#2B6CB0',
    accents: ['#2B6CB0', '#B7791F', '#2F855A'], muted: '#9AA5B1',
  },
  type: {
    family: "'Kalam', cursive", titleRem: 3.2, bodyRem: 2.0,
    labelRem: 1.6, minRem: 1.4, lineHeight: 1.35, letterSpacingEm: 0,
  },
  motion: {
    drawMsPer100px: 180, revealMs: 260, staggerMs: 90,
    ease: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
});

/** A scene that uses free-form markup, an SVG, and two anchored reveals. */
function sceneWithDiagram(): Scene {
  const base = Scene.of({
    index: 0,
    spokenText: 'Glycolysis produces pyruvate which enters the Krebs cycle',
    citations: [Citation.of('c0', [SourceRef.page('doc', 1)])],
    visualIntent: 'flow',
    estimatedDuration: Duration.fromMs(4000),
  });

  // Written the way the storyboard prompt asks for it: a scoped <style> block
  // rather than inline styles, and reveal times derived from the timeline rather
  // than hand-written — `buildSceneDocument` sanitises and stamps them.
  const html = `<section class="sc-scene" data-scene="0">
  <style>
    .sc-flow { display: flex; gap: 2rem; align-items: center; }
    .sc-node {
      border: 3px solid var(--ink-accent);
      border-radius: 8px;
      padding: 1rem 1.5rem;
      font-size: var(--type-body);
    }
  </style>
  <h2 class="sc-title">Cellular respiration</h2>
  <div class="sc-flow">
    <div class="sc-node" id="n0">Glycolysis</div>
    <div class="sc-connector" id="a0" data-draw="normal"></div>
    <div class="sc-node" id="n1">Pyruvate</div>
  </div>
</section>`;

  const anchors = [
    { elementId: 'n0', phrase: 'Glycolysis', draw: 'normal' as const, hold: true },
    { elementId: 'n1', phrase: 'pyruvate', draw: 'normal' as const, hold: true },
  ];
  const timings = [
    WordTiming.of('Glycolysis', 0, 400),
    WordTiming.of('pyruvate', 900, 1400),
  ];
  return base.withStoryboard(html, SceneTimeline.unresolved(anchors).resolve(timings));
}

let workDir: string | undefined;
afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe.skipIf(!available)('PlaywrightSceneRenderer (needs Chromium)', () => {
  const logger = createLogger({ level: 'silent', redactPaths: [] });

  async function render(): Promise<{ path: string; frames: number }> {
    workDir ??= await mkdtemp(join(tmpdir(), 'pw-render-'));
    const pool = new BrowserPool(
      { ...(chromium ? { executablePath: chromium } : {}), width: preset.width, height: preset.height },
      logger,
    );
    try {
      const storyboard = Storyboard.of([sceneWithDiagram()], preset, Duration.zero());
      const renderer = new PlaywrightSceneRenderer(theme, pool, logger);
      const [segment] = renderer.planSegments(storyboard, 6);
      const out = join(workDir, `seg-${Date.now()}.mp4`);
      const result = await renderer.renderSegment({ storyboard, segment: segment!, outputPath: out });
      return { path: result.path, frames: result.frameCount };
    } finally {
      await pool.close();
    }
  }

  it('produces a real MP4 at the preset resolution and duration', async () => {
    const { path, frames } = await render();

    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_name,width,height:format=duration',
      '-of', 'default=nw=1', path,
    ]);

    expect(stdout).toContain('codec_name=h264');
    expect(stdout).toContain('width=1280');
    expect(stdout).toContain('height=720');

    const duration = Number(/duration=([\d.]+)/.exec(stdout)?.[1] ?? 0);
    // The whole point of the concat schedule is that held stills preserve
    // duration exactly; drift here means the video desyncs from its audio.
    expect(duration).toBeCloseTo(frames / preset.fps, 1);
  }, 120_000);

  it('blocks outbound requests even when the sanitiser is bypassed', async () => {
    // The sanitiser rejects external references, but it is regex-based and can
    // have a bug. This asserts the second layer independently: markup that never
    // went through the sanitiser still cannot reach anything.
    const pool = new BrowserPool(
      { ...(chromium ? { executablePath: chromium } : {}), width: 320, height: 240 },
      logger,
    );
    try {
      const page = await pool.page();
      const attempted: string[] = [];
      page.on('requestfailed', (r) => attempted.push(r.url()));

      await page.setContent(
        `<img src="http://127.0.0.1:9/evil.png">
         <link rel="stylesheet" href="http://127.0.0.1:9/evil.css">`,
        { waitUntil: 'domcontentloaded' },
      );

      // Every attempt is aborted; none may succeed.
      for (const url of attempted) expect(url).toMatch(/127\.0\.0\.1:9/);
      const succeeded = await page.evaluate(
        'Array.from(document.images).filter(function (i) { return i.complete && i.naturalWidth > 0; }).length',
      );
      expect(succeeded).toBe(0);
    } finally {
      await pool.close();
    }
  }, 60_000);

  it('is deterministic — the same segment renders byte-identically', async () => {
    // The chaos test replaces a segment on a different worker and expects the
    // replacement to match. Wall-clock animation would break that silently.
    const [first, second] = [await render(), await render()];
    const [a, b] = [await readFile(first.path), await readFile(second.path)];
    expect(a.equals(b)).toBe(true);
  }, 240_000);

  it('previews a scene as a still with every reveal landed', async () => {
    // What the judge is handed. It must show the *settled* scene — an image
    // caught mid-reveal would have the judge failing scenes for being
    // half-drawn.
    const pool = new BrowserPool(
      { ...(chromium ? { executablePath: chromium } : {}), width: preset.width, height: preset.height },
      logger,
    );
    try {
      workDir ??= await mkdtemp(join(tmpdir(), 'pw-render-'));
      const previewer = new PlaywrightScenePreviewer(
        theme, pool, logger, preset.width, preset.height,
      );
      const out = join(workDir, 'preview.png');
      const { paths } = await previewer.capture({
        board: Board.forScene(sceneWithDiagram()), outputPathFor: () => out,
      });

      // A standalone scene is a board of one step, so it yields one image.
      expect(paths).toEqual([out]);
      const bytes = await readFile(out);
      expect(bytes.length).toBeGreaterThan(5_000);
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    } finally {
      await pool.close();
    }
  }, 60_000);

  /**
   * The board is `overflow: hidden`, so a scene that outgrows the frame used to
   * lose its bottom silently — the only thing that would have caught it was the
   * vision judge, which is a stub by default. These two check the measurement
   * happens in a real layout engine, which is the only place it can.
   */
  it('scales an overflowing scene instead of clipping it', async () => {
    const pool = new BrowserPool(
      { ...(chromium ? { executablePath: chromium } : {}), width: 640, height: 360 },
      logger,
    );
    try {
      const page = await pool.page({ width: 640, height: 360 });
      const tall = Scene.of({
        index: 0, spokenText: 'overflowing', visualIntent: 'focus',
        citations: [Citation.of('c', [SourceRef.page('d', 1)])],
        estimatedDuration: Duration.fromMs(1000),
      }).withStoryboard(
        `<section class="sc-scene"><h2 class="sc-title">Long</h2>${
          Array.from({ length: 40 }, (_, i) => `<p class="sc-item">Line ${i} of a scene that will not fit.</p>`).join('')
        }</section>`,
        SceneTimeline.unresolved([]),
      );

      await page.setContent(
        buildSceneDocument({ scene: tall, theme, width: 640, height: 360 }),
        { waitUntil: 'domcontentloaded' },
      );
      await page.evaluate('window.__seekTo(0)');

      const fitted = await page.evaluate('document.documentElement.getAttribute("data-fitted")');
      expect(fitted, 'an overflowing scene should be scaled').not.toBeNull();
      expect(Number(fitted)).toBeLessThan(1);
      expect(Number(fitted)).toBeGreaterThanOrEqual(0.6);

      await page.context().close();
    } finally {
      await pool.close();
    }
  }, 60_000);

  it('leaves a scene that fits at full size', async () => {
    const pool = new BrowserPool(
      { ...(chromium ? { executablePath: chromium } : {}), width: preset.width, height: preset.height },
      logger,
    );
    try {
      const page = await pool.page({ width: preset.width, height: preset.height });
      await page.setContent(
        buildSceneDocument({ scene: sceneWithDiagram(), theme, width: preset.width, height: preset.height }),
        { waitUntil: 'domcontentloaded' },
      );
      await page.evaluate('window.__seekTo(2000)');
      expect(await page.evaluate('document.documentElement.getAttribute("data-fitted")')).toBeNull();
      await page.context().close();
    } finally {
      await pool.close();
    }
  }, 60_000);

  /**
   * The hand-drawn primitive: a stroke advancing along its own geometry rather
   * than a rectangle being stretched. Checked in a browser because it depends
   * on `pathLength` normalisation and computed style, neither of which exists
   * outside one.
   */
  it('draws an SVG stroke along its path as time advances', async () => {
    const pool = new BrowserPool(
      { ...(chromium ? { executablePath: chromium } : {}), width: preset.width, height: preset.height },
      logger,
    );
    try {
      const page = await pool.page({ width: preset.width, height: preset.height });
      const drawn = Scene.of({
        index: 0, spokenText: 'glucose becomes pyruvate', visualIntent: 'parts',
        citations: [Citation.of('c', [SourceRef.page('d', 1)])],
        estimatedDuration: Duration.fromMs(2000),
      }).withStoryboard(
        `<section class="sc-scene"><h2 class="sc-title">Path</h2>
         <svg class="sc-link" viewBox="0 0 200 60">
           <path class="sc-arrow" id="p1" d="M4 30 C60 4, 140 56, 196 30" pathLength="1"/>
         </svg></section>`,
        SceneTimeline.unresolved([
          { elementId: 'p1', phrase: 'pyruvate', draw: 'normal', hold: true },
        ]).resolve([
          WordTiming.of('glucose', 0, 400),
          WordTiming.of('becomes', 400, 800),
          WordTiming.of('pyruvate', 800, 1300),
        ]),
      );

      await page.setContent(
        buildSceneDocument({ scene: drawn, theme, width: preset.width, height: preset.height }),
        { waitUntil: 'domcontentloaded' },
      );

      // Chromium reports the computed offset as `calc(0.09px)` mid-draw and
      // `0%` once settled, so the number is extracted rather than parsed off a
      // fixed unit suffix.
      const offsetAt = async (ms: number): Promise<number> => {
        await page.evaluate(`window.__seekTo(${ms})`);
        const raw = String(await page.evaluate(
          'getComputedStyle(document.getElementById("p1")).strokeDashoffset',
        ));
        return Number(/-?[\d.]+/.exec(raw)?.[0] ?? NaN);
      };

      // Before its moment the stroke is fully retracted; after, fully drawn.
      expect(await offsetAt(0)).toBeCloseTo(1, 2);
      expect(await offsetAt(2000)).toBeCloseTo(0, 2);
      // And it is genuinely mid-draw in between, not a two-state fade.
      const mid = await offsetAt(900);
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1);

      await page.context().close();
    } finally {
      await pool.close();
    }
  }, 60_000);

  it('returns undefined rather than throwing when a scene has no markup', async () => {
    // A preview failure must degrade the judge to text-only, never reject the
    // scene — the screenshot is an aid, not a gate.
    const pool = new BrowserPool(
      { ...(chromium ? { executablePath: chromium } : {}), width: 320, height: 240 },
      logger,
    );
    try {
      const previewer = new PlaywrightScenePreviewer(theme, pool, logger, 320, 240);
      const bare = Scene.of({
        index: 0, spokenText: 'x', visualIntent: 'focus',
        citations: [Citation.of('c', [SourceRef.page('d', 1)])],
        estimatedDuration: Duration.fromMs(1000),
      });
      expect((await previewer.capture({
        board: Board.forScene(bare), outputPathFor: () => '/tmp/never.png',
      })).paths).toEqual([]);
    } finally {
      await pool.close();
    }
  }, 60_000);

  it('applies the visual plan palette over the theme', async () => {
    const pool = new BrowserPool(
      { ...(chromium ? { executablePath: chromium } : {}), width: preset.width, height: preset.height },
      logger,
    );
    try {
      workDir ??= await mkdtemp(join(tmpdir(), 'pw-render-'));
      const previewer = new PlaywrightScenePreviewer(theme, pool, logger, preset.width, preset.height);

      const plan = VisualPlan.of({
        palette: {
          ground: '#FFFDF5', ink: '#1A1A1A',
          accents: ['#C05621', '#2F855A'], muted: '#A0A0A0',
        },
        scenes: [],
      });

      const [plain, themed] = [join(workDir, 'p.png'), join(workDir, 't.png')];
      await previewer.capture({
        board: Board.forScene(sceneWithDiagram()), outputPathFor: () => plain,
      });
      await previewer.capture({
        board: Board.forScene(sceneWithDiagram()), outputPathFor: () => themed, visualPlan: plan,
      });

      // Different palettes must produce different pixels, or the plan is inert.
      const [a, b] = [await readFile(plain), await readFile(themed)];
      expect(a.equals(b)).toBe(false);
    } finally {
      await pool.close();
    }
  }, 120_000);

  it('renders a non-default preset at its own dimensions', async () => {
    // The browser viewport was pinned to the *default* preset while the renderer
    // clipped to the *job's* preset, so a vertical or 1080p job asked Chromium
    // for a region larger than the page it was given.
    const vertical = QualityPreset.of({
      name: 'vertical', width: 720, height: 1280, fps: 24, codec: 'h264', crf: 23,
    });
    const pool = new BrowserPool(
      { ...(chromium ? { executablePath: chromium } : {}), width: 1280, height: 720 },
      logger,
    );
    try {
      workDir ??= await mkdtemp(join(tmpdir(), 'pw-render-'));
      const storyboard = Storyboard.of([sceneWithDiagram()], vertical, Duration.zero());
      const renderer = new PlaywrightSceneRenderer(theme, pool, logger);
      const [segment] = renderer.planSegments(storyboard, 6);
      const out = join(workDir, 'vertical.mp4');
      await renderer.renderSegment({ storyboard, segment: segment!, outputPath: out });

      const { stdout } = await run('ffprobe', [
        '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'default=nw=1', out,
      ]);
      expect(stdout).toContain('width=720');
      expect(stdout).toContain('height=1280');
    } finally {
      await pool.close();
    }
  }, 120_000);

  it('gives the title its own size despite the legibility floor', async () => {
    // `.sc-scene *` and `.sc-title` have identical specificity, so source order
    // decides. Reasoning about that is exactly how a title silently collapses to
    // body size, so it is measured rather than argued.
    const pool = new BrowserPool(
      { ...(chromium ? { executablePath: chromium } : {}), width: preset.width, height: preset.height },
      logger,
    );
    try {
      const page = await pool.page({ width: preset.width, height: preset.height });
      await page.setContent(
        buildSceneDocument({ scene: sceneWithDiagram(), theme, width: preset.width, height: preset.height }),
        { waitUntil: 'domcontentloaded' },
      );

      const sizes = await page.evaluate(`(function () {
        var t = document.querySelector('.sc-title');
        var n = document.querySelector('.sc-node');
        return {
          title: parseFloat(getComputedStyle(t).fontSize),
          node: parseFloat(getComputedStyle(n).fontSize),
          family: getComputedStyle(t).fontFamily,
        };
      })()`) as { title: number; node: number; family: string };

      // 3.2rem vs 2rem at the default root size.
      expect(sizes.title).toBeGreaterThan(sizes.node);
      expect(sizes.title).toBeCloseTo(3.2 * 16, 0);
      // The vendored face, not a fallback — a silent fallback changes every
      // measurement on the page.
      expect(sizes.family).toContain('Kalam');
    } finally {
      await pool.close();
    }
  }, 60_000);

});
