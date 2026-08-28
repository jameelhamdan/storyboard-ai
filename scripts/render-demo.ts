/**
 * Renders every diagram shape straight through the Playwright renderer.
 *
 * No model calls and no speech: the diagrams below are hand-written, so this
 * exercises the renderer, the layout templates, the palette, the reveal timing
 * and the encode without spending anything. It is the loop to use while
 * iterating on how boards look — and the cheapest way to see all twelve shapes
 * at once, which is the thing unit tests cannot tell you.
 *
 * It deliberately bypasses DurationPolicy, so the demo can be short.
 *
 *   docker compose run --rm --entrypoint "npx tsx scripts/render-demo.ts" e2e
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/interfaces/config/loadConfig.js';
import { createLogger } from '../src/infrastructure/observability/logger.js';
import { BrowserPool } from '../src/infrastructure/render/BrowserPool.js';
import { PlaywrightSceneRenderer } from '../src/infrastructure/render/PlaywrightSceneRenderer.js';
import { FfmpegRunner } from '../src/infrastructure/encode/FfmpegRunner.js';
import { Storyboard } from '../src/domain/script/Storyboard.js';
import { Scene } from '../src/domain/script/Scene.js';
import { SceneTimeline } from '../src/domain/script/SceneTimeline.js';
import { Duration } from '../src/domain/shared/Duration.js';
import { WordTiming } from '../src/domain/media/WordTiming.js';
import { VisualPlan } from '../src/domain/media/VisualPlan.js';
import { Citation } from '../src/domain/content/Citation.js';
import { SourceRef } from '../src/domain/content/SourceRef.js';
import { renderDiagram } from '../src/infrastructure/render/diagram/renderDiagram.js';
import { DEMOS, demoDiagram } from './demo-boards.js';

const OUT = process.env['DEMO_OUT'] ?? '/out';
const SECONDS = Number(process.env['DEMO_SECONDS'] ?? '48');


/** A subject-appropriate palette, as the visualPlan stage would choose. */
const plan = VisualPlan.of({
  palette: {
    ground: '#FBFAF7',
    ink: '#1E2A32',
    accents: ['#1F6FB2', '#C2691D', '#2E7D5B'],
    muted: '#9AA5B1',
  },
  scenes: [],
});


const config = loadConfig();
const logger = createLogger({ level: 'warn', redactPaths: [], pretty: true });
const preset = config.resolved.defaultPreset;
const perScene = (SECONDS * 1000) / DEMOS.length;

const scenes = await Promise.all(DEMOS.map(async (spec, index) => {
  const diagram = await demoDiagram(spec, index);
  const { html, anchors } = renderDiagram(diagram, index);

  // Reveals spread across the scene, so every element is seen arriving.
  const phrases = diagram.anchorPhrases;
  const step = perScene / (phrases.length + 1);
  const timings = phrases.map((phrase, i) =>
    WordTiming.of(phrase, Math.round(step * (i + 1)), Math.round(step * (i + 1)) + 300),
  );

  return Scene.of({
    index,
    spokenText: spec.narration,
    visualIntent: diagram.shape,
    citations: [Citation.of(`c${index}`, [SourceRef.section('demo', `Scene ${index + 1}`)])],
    estimatedDuration: Duration.fromMs(perScene),
  }).withStoryboard(html, SceneTimeline.unresolved(anchors).resolve(timings));
}));

const storyboard = Storyboard.of(scenes, preset, Duration.zero());
const pool = new BrowserPool(
  {
    ...(config.env.CHROMIUM_PATH ? { executablePath: config.env.CHROMIUM_PATH } : {}),
    width: preset.width, height: preset.height,
  },
  logger,
);

await mkdir(OUT, { recursive: true });
const ffmpeg = new FfmpegRunner();
const renderer = new PlaywrightSceneRenderer(config.resolved.defaultTheme, pool, logger, ffmpeg);

console.log(`\n  ${DEMOS.length} boards · ${SECONDS}s · ${preset.width}x${preset.height}@${preset.fps}\n`);

const started = Date.now();
const segments = renderer.planSegments(storyboard, 4);
const parts: string[] = [];

for (const segment of segments) {
  const path = join(OUT, `demo-seg-${segment.index}.mp4`);
  const result = await renderer.renderSegment({ storyboard, segment, outputPath: path, visualPlan: plan });
  parts.push(result.path);
  console.log(`  segment ${segment.index}  ${result.frameCount} frames  ${result.wallSeconds.toFixed(1)}s`);
}

await pool.close();

// Stitch the segments the same way the assemble stage does.
const listPath = join(OUT, 'demo-concat.txt');
const { writeFile } = await import('node:fs/promises');
await writeFile(listPath, parts.map((p) => `file '${p}'`).join('\n') + '\n', 'utf8');
const final = join(OUT, 'demo.mp4');
await ffmpeg.run(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', final]);

console.log(`\n  video   ${final}`);
console.log(`  took    ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
