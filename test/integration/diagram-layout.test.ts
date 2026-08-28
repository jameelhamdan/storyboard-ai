import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';

import { buildSceneDocument } from '@infrastructure/render/page/document.js';
import { renderDiagram } from '@infrastructure/render/diagram/renderDiagram.js';
import { DIAGRAM_SHAPES } from '@domain/script/DiagramShape.js';
import { Scene } from '@domain/script/Scene.js';
import { SceneTimeline } from '@domain/script/SceneTimeline.js';
import { Duration } from '@domain/shared/Duration.js';
import { Theme } from '@domain/media/Theme.js';
import { Citation } from '@domain/content/Citation.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { DEMOS, demoDiagram } from '../../scripts/demo-boards.js';

/**
 * The test the previous design could not have.
 *
 * Overlap, clipping and undersized text were delegated to a vision model
 * reading a screenshot, because the model wrote its own CSS and there was no
 * layout to assert against. That judge passed a board whose centre box covered
 * the label beside it (`out/20260827-202226-battery`, scene 0, all five gates
 * green, holistic 4). Now that the renderer owns position, the same properties
 * are measurable — for free, deterministically, and on every shape rather than
 * on whichever ones a paid run happened to produce.
 *
 * It runs against a real browser because that is the only thing that knows
 * where a flex item ends up. jsdom reports zero for every box.
 */
const WIDTH = 1280;
const HEIGHT = 720;

/** Playwright's bundled browser locally; the image's Chromium in CI. */
const configured = process.env['CHROMIUM_PATH'];
const executablePath = configured && existsSync(configured) ? configured : chromium.executablePath();
const available = Boolean(executablePath && existsSync(executablePath));

const theme = Theme.of('standard', {
  board: { background: '#FFFFFF', paddingRem: 4, vignette: 'none' },
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

/**
 * Everything that carries ink and is not allowed to sit on top of anything
 * else. Containers are deliberately absent: `nested` boxes contain each other
 * by design, so asserting on the labels rather than the frames tests the thing
 * that would actually be unreadable.
 */
const INKED = [
  '.sc-title', '.sc-caption', '.sc-node', '.sc-side', '.sc-layer', '.sc-cell',
  '.sc-part', '.sc-term', '.sc-event', '.sc-bar-row', '.sc-nest-label',
  '.sc-focus-text', '.sc-whole', '.sc-axis-x', '.sc-axis-y',
].join(',');

interface Measured {
  readonly boxes: { sel: string; text: string; left: number; top: number; right: number; bottom: number }[];
  readonly fitted: string;
  readonly smallestFontPx: number;
}

describe.skipIf(!available)('every diagram shape lays out without overlapping or clipping', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath, args: ['--font-render-hinting=none'] });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function measure(index: number): Promise<Measured> {
    const spec = DEMOS[index]!;
    const diagram = await demoDiagram(spec, index);
    const { html, anchors } = renderDiagram(diagram, index);

    const scene = Scene.of({
      index,
      spokenText: spec.narration,
      visualIntent: diagram.shape,
      citations: [Citation.of(`c${index}`, [SourceRef.section('demo', 'S')])],
      estimatedDuration: Duration.fromSeconds(4),
    }).withStoryboard(html, SceneTimeline.unresolved(anchors));

    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
    const page = await context.newPage();
    try {
      await page.setContent(
        buildSceneDocument({ scene, theme, width: WIDTH, height: HEIGHT }),
        { waitUntil: 'domcontentloaded' },
      );
      // Past every reveal: elements mid-animation are still moving, and a board
      // is judged on the state a viewer holds on.
      await page.evaluate('window.__seekTo(600000)');

      return (await page.evaluate(`(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(INKED)})];
        const boxes = els.map((e) => {
          const b = e.getBoundingClientRect();
          return {
            sel: e.className, text: (e.textContent || '').trim().slice(0, 24),
            left: b.left, top: b.top, right: b.right, bottom: b.bottom,
          };
        }).filter((b) => b.right > b.left && b.bottom > b.top);

        const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize)).filter((n) => n > 0);
        return {
          boxes,
          fitted: document.documentElement.dataset.fitted ?? '',
          smallestFontPx: Math.min(...sizes),
        };
      })()`)) as Measured;
    } finally {
      await context.close();
    }
  }

  const cases = DEMOS.map((d, i) => [d.shape, i] as const);

  it.each(cases)('%s: no two inked elements overlap', async (_shape, index) => {
    const { boxes } = await measure(index);
    expect(boxes.length).toBeGreaterThan(1);

    // A pixel of tolerance: adjacent borders and sub-pixel rounding are not
    // collisions, and `stack` deliberately shares edges between its bands.
    const collisions: string[] = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 1 && overlapY > 1) {
          collisions.push(`"${a.text}" overlaps "${b.text}" by ${overlapX.toFixed(0)}x${overlapY.toFixed(0)}px`);
        }
      }
    }
    expect(collisions).toEqual([]);
  }, 60_000);

  it.each(cases)('%s: nothing is clipped by the frame', async (_shape, index) => {
    const { boxes } = await measure(index);
    const clipped = boxes
      .filter((b) => b.left < -1 || b.top < -1 || b.right > WIDTH + 1 || b.bottom > HEIGHT + 1)
      .map((b) => `"${b.text}" at ${b.left.toFixed(0)},${b.top.toFixed(0)}-${b.right.toFixed(0)},${b.bottom.toFixed(0)}`);
    expect(clipped).toEqual([]);
  }, 60_000);

  it.each(cases)('%s: fits without being scaled down to fit', async (_shape, index) => {
    // `__fitToFrame` shrinking a board is a symptom, not a solution — it means
    // the template produced something too big for its own frame.
    const { fitted } = await measure(index);
    expect(fitted).toBe('');
  }, 60_000);

  it.each(cases)('%s: stays above the legibility floor', async (_shape, index) => {
    // 1.4rem at a 16px root. The universal font-size floor was removed from the
    // stylesheet because it silently overrode every component size; this is what
    // replaces it — a measurement rather than a rule that fights the design.
    const { smallestFontPx } = await measure(index);
    expect(smallestFontPx).toBeGreaterThanOrEqual(1.4 * 16 - 0.5);
  }, 60_000);

  /**
   * The judged image must be the shipped image.
   *
   * The judge screenshots a scene by seeking straight past the end; the renderer
   * reuses one page per segment and seeks to frame 0 first. `__fitToFrame`
   * caches its measurement, so whichever call arrives first decides the scale
   * for the whole scene.
   *
   * Today they agree, and not by accident: every reveal effect is a transform,
   * an opacity or a clip-path, none of which participate in layout. This holds
   * that invariant. A reveal that animated margin, width or font-size would
   * break it, and the symptom would be a judge approving a frame nobody sees —
   * which is very hard to notice from either end.
   *
   * Measured on a deliberately short frame, because the fit only engages on a
   * board that overflows.
   */
  it('computes the same fit whether or not a frame was seeked first', async () => {
    const short = 200;
    const spec = DEMOS.find((d) => d.shape === 'stack')!;
    const diagram = await demoDiagram(spec);
    const { html, anchors } = renderDiagram(diagram, 0);

    const scene = Scene.of({
      index: 0,
      spokenText: spec.narration,
      visualIntent: diagram.shape,
      citations: [Citation.of('c0', [SourceRef.section('demo', 'S')])],
      estimatedDuration: Duration.fromSeconds(4),
    }).withStoryboard(html, SceneTimeline.unresolved(anchors));

    const fitAfter = async (seeks: readonly number[]) => {
      const context = await browser.newContext({ viewport: { width: WIDTH, height: short } });
      const page = await context.newPage();
      try {
        await page.setContent(
          buildSceneDocument({ scene, theme, width: WIDTH, height: short }),
          { waitUntil: 'domcontentloaded' },
        );
        for (const ms of seeks) await page.evaluate(`window.__seekTo(${ms})`);
        return (await page.evaluate('document.documentElement.dataset.fitted ?? ""')) as string;
      } finally {
        await context.close();
      }
    };

    const judgePath = await fitAfter([600_000]);
    const renderPath = await fitAfter([0, 600_000]);

    expect(judgePath, 'the board should have needed scaling for this to prove anything').not.toBe('');
    expect(renderPath).toBe(judgePath);
  }, 60_000);

  it('covers every shape in the vocabulary', () => {
    // A shape with no demo board is a template nothing above ever renders.
    expect([...new Set(DEMOS.map((d) => d.shape))].sort()).toEqual([...DIAGRAM_SHAPES].sort());
  });
});
