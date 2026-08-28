/**
 * Screenshots one still of every diagram shape.
 *
 * The fastest way to see whether a template lays out correctly — no encode, no
 * segments, no ffmpeg. Frames are what caught every layout defect in
 * out/20260827-202226-battery; markup tests caught none of them.
 *
 *   npx tsx scripts/shape-shots.ts
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/interfaces/config/loadConfig.js';
import { createLogger } from '../src/infrastructure/observability/logger.js';
import { BrowserPool } from '../src/infrastructure/render/BrowserPool.js';
import { buildSceneDocument } from '../src/infrastructure/render/page/document.js';
import { Scene } from '../src/domain/script/Scene.js';
import { SceneTimeline } from '../src/domain/script/SceneTimeline.js';
import { Duration } from '../src/domain/shared/Duration.js';
import { Citation } from '../src/domain/content/Citation.js';
import { SourceRef } from '../src/domain/content/SourceRef.js';
import { renderDiagram } from '../src/infrastructure/render/diagram/renderDiagram.js';
import { VisualPlan } from '../src/domain/media/VisualPlan.js';
import { DEMOS, demoDiagram } from './demo-boards.js';

const OUT = process.env['SHOT_OUT'] ?? 'out/shapes';
const config = loadConfig();

/** The palette the visualPlan stage would choose, so stills match a real run. */
const plan = VisualPlan.of({
  palette: {
    ground: '#FBFAF7', ink: '#1E2A32',
    accents: ['#1F6FB2', '#C2691D', '#2E7D5B'], muted: '#9AA5B1',
  },
  scenes: [],
});
const logger = createLogger({ level: 'warn', redactPaths: [], pretty: true });
const preset = config.resolved.defaultPreset;

await mkdir(OUT, { recursive: true });
const pool = new BrowserPool(
  {
    ...(config.env.CHROMIUM_PATH ? { executablePath: config.env.CHROMIUM_PATH } : {}),
    width: preset.width, height: preset.height,
  },
  logger,
);

for (const [index, spec] of DEMOS.entries()) {
  const diagram = await demoDiagram(spec, index);
  const { html, anchors } = renderDiagram(diagram, index);

  const scene = Scene.of({
    index,
    spokenText: spec.narration,
    visualIntent: diagram.shape,
    citations: [Citation.of(`c${index}`, [SourceRef.section('demo', `Scene ${index}`)])],
    estimatedDuration: Duration.fromSeconds(4),
  }).withStoryboard(html, SceneTimeline.unresolved(anchors));

  const page = await pool.page({ width: preset.width, height: preset.height });
  await page.setContent(
    buildSceneDocument({ scene, theme: config.resolved.defaultTheme, width: preset.width, height: preset.height, visualPlan: plan }),
    { waitUntil: 'domcontentloaded' },
  );
  await page.evaluate('window.__seekTo(600000)');
  const path = join(OUT, `${String(index).padStart(2, '0')}-${diagram.shape}.png`);
  await page.screenshot({ path, type: 'png', clip: { x: 0, y: 0, width: preset.width, height: preset.height } });

  // What the frame actually contains, rather than what the CSS was meant to do.
  // A board that renders correctly and occupies a third of the frame still
  // reads as an empty slide, and only a measurement says which one you have.
  const metrics = await page.evaluate(`(() => {
    const box = (s) => { const e = document.querySelector(s); if (!e) return null;
      const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
    const plate = box('.sc-plate');
    const content = [...document.querySelectorAll('.sc-plate *')]
      .map((e) => e.getBoundingClientRect())
      .filter((b) => b.width > 0 && b.height > 0);
    const top = Math.min(...content.map((b) => b.top));
    const bottom = Math.max(...content.map((b) => b.bottom));
    return { fitted: document.documentElement.dataset.fitted ?? '-', plate, top: Math.round(top), bottom: Math.round(bottom) };
  })()`) as { fitted: string; plate: { top: number; bottom: number } | null; top: number; bottom: number };

  await page.context().close();
  const fill = ((metrics.bottom - metrics.top) / preset.height * 100).toFixed(0);
  console.log(
    `  ${String(index).padStart(2, '0')}-${diagram.shape.padEnd(11)}` +
    ` content ${String(metrics.top).padStart(4)}..${String(metrics.bottom).padStart(4)}` +
    ` (${fill.padStart(2)}% of frame)  plate ${metrics.plate?.top}..${metrics.plate?.bottom}` +
    `  fit ${metrics.fitted}`,
  );
}

await pool.close();
