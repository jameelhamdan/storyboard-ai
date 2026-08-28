import { readFileSync } from 'node:fs';
import type { Theme } from '@domain/media/Theme.js';
import type { VisualPlan } from '@domain/media/VisualPlan.js';
import type { Scene } from '@domain/script/Scene.js';
import { fontPath } from '../fonts.js';
import { HtmlSanitizer } from '../HtmlSanitizer.js';
import { SEEK_SCRIPT } from './seek.js';
import { BASE_STYLESHEET, IDENTITY_LOCK } from './stylesheet.js';

export interface DocumentInput {
  readonly scene: Scene;
  readonly theme: Theme;
  readonly width: number;
  readonly height: number;
  /** Overrides the theme's colours for this video. */
  readonly visualPlan?: VisualPlan;
}

/**
 * Builds the standalone page a scene is rendered from.
 *
 * Everything is inlined — stylesheet, font, script — because the page is loaded
 * via `setContent` with every outbound request blocked. `docs/whiteboard-style.md`
 * is explicit that a missing font silently falls back and changes every layout,
 * so the face travels as a data URI rather than as a path the browser might not
 * resolve.
 */
export function buildSceneDocument(input: DocumentInput): string {
  const { scene, theme, width, height, visualPlan } = input;

  // Sanitised here as well as at the judge, because this is the last point
  // before the markup reaches a browser and the two call sites can drift.
  const { html } = new HtmlSanitizer().sanitize(scene.html ?? '');
  const body = injectRevealTimes(html, scene);

  return `<!doctype html>
<html data-reveal-ms="${theme.tokens.motion.revealMs}"
      data-stagger-ms="${theme.tokens.motion.staggerMs}"
      data-vignette="${theme.tokens.board.vignette}">
<head>
<meta charset="utf-8">
<style>
${fontFace()}
:root {
  ${theme.toCssVariables()}
  ${visualPlan ? visualPlan.toCssVariables() : ''}
  --frame-width: ${width}px;
  --frame-height: ${height}px;
}
${BASE_STYLESHEET}
</style>
</head>
<body>
<main class="sc-board">
${body}
</main>
<style>${IDENTITY_LOCK}</style>
<script>${SEEK_SCRIPT}</script>
</body>
</html>`;
}

/**
 * Stamps each element's resolved reveal time onto it as `data-reveal-at`, plus
 * the two things the seek script needs to vary how it arrives.
 *
 * The timeline resolves anchors to times and keys them by `elementId`; the
 * markup carries matching `id` attributes. Nothing previously joined the two, so
 * the page had times available in Node and no way to read them in the browser.
 *
 * `data-draw-speed` carries the anchor's own speed. The model has always chosen
 * one per element and it has never reached the page — every reveal played at the
 * same global duration regardless of what was asked for.
 *
 * `data-stagger-index` is the element's position among reveals sharing its
 * moment. Computed here rather than in the browser so it is stable across
 * renders: two workers rendering the same frame must produce the same pixels.
 *
 * Written as attributes rather than injected CSS because `__seekTo` reads them
 * per element on every frame, and an attribute is the cheapest thing to query.
 */
function injectRevealTimes(html: string, scene: Scene): string {
  let output = html;

  // Reveals landing on the same millisecond are a group; their order within it
  // decides the stagger offset. `reveals` is already sorted by resolved time.
  const orderAtSameTime = new Map<string, number>();
  const seenAt = new Map<number, number>();
  for (const reveal of scene.timeline.reveals) {
    const ms = Math.max(0, Math.round(reveal.at.ms));
    const index = seenAt.get(ms) ?? 0;
    orderAtSameTime.set(reveal.elementId, index);
    seenAt.set(ms, index + 1);
  }

  for (const reveal of scene.timeline.reveals) {
    const ms = Math.max(0, Math.round(reveal.at.ms));
    const order = orderAtSameTime.get(reveal.elementId) ?? 0;

    const added =
      ` data-reveal-at="${ms}"` +
      ` data-draw-speed="${reveal.draw}"` +
      (order > 0 ? ` data-stagger-index="${order}"` : '');

    // Match the opening tag carrying this id, and add the attributes to it.
    const pattern = new RegExp(
      `(<[a-z0-9-]+\\b[^>]*\\bid\\s*=\\s*["']${escapeRegExp(reveal.elementId)}["'][^>]*?)(\\s*/?>)`,
      'i',
    );
    output = output.replace(pattern, (_match, open: string, close: string) =>
      open.includes('data-reveal-at') ? `${open}${close}` : `${open}${added}${close}`);
  }

  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The handwriting face, base64-inlined.
 *
 * Read once and cached: a scene document is built per segment, and re-reading a
 * 420KB file for each would be pure waste.
 */
let cachedFontFace: string | undefined;

function fontFace(): string {
  if (cachedFontFace !== undefined) return cachedFontFace;

  const path = fontPath('Kalam-Regular.ttf');
  if (!path) {
    // Loud rather than silent: a fallback face changes every measurement on the
    // page, and the resulting video looks subtly wrong for no visible reason.
    cachedFontFace = '/* Kalam not found — falling back to a system face */';
    return cachedFontFace;
  }

  const base64 = readFileSync(path).toString('base64');
  cachedFontFace = `@font-face {
  font-family: 'Kalam';
  font-style: normal;
  font-weight: 400;
  src: url(data:font/ttf;base64,${base64}) format('truetype');
}`;
  return cachedFontFace;
}
