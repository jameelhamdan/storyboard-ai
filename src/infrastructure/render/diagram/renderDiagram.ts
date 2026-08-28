import type { DiagramShape } from '@domain/script/DiagramShape.js';
import type { SceneDiagram, DiagramNode } from '@domain/script/SceneDiagram.js';
import type { TimelineAnchor } from '@domain/script/SceneTimeline.js';
import { arrowRight, returnArc, bracket, leader, axis, underline } from './connectors.js';

export interface RenderedDiagram {
  readonly html: string;
  readonly anchors: readonly TimelineAnchor[];
}

/**
 * Turns a diagram description into the markup that gets rendered.
 *
 * One template per shape, and every one of them lays out with grid or flex —
 * so the elements on a board are siblings in normal flow and **cannot overlap**.
 * That is the whole reason this file exists. Previously the model wrote its own
 * CSS and its own positions, nothing measured the result, and a board whose
 * centre box covered its right-hand label passed all five judge gates.
 *
 * Two constraints on anything added here:
 *
 * - **No inline `style` attributes.** `HtmlSanitizer` strips them, and strips
 *   them *silently* — the old fallback's proportion bars set `style="width:…"`
 *   and rendered at zero width with nothing reporting it. Widths come from the
 *   `sc-w-*` classes instead.
 * - **No absolute positioning.** It is the one thing that can reintroduce
 *   overlap, and every shape here is expressible without it — including `cycle`,
 *   which is a row with a return arc beneath rather than a ring.
 */
export function renderDiagram(diagram: SceneDiagram, sceneIndex: number): RenderedDiagram {
  const id = {
    title: `s${sceneIndex}-title`,
    node: (i: number) => `s${sceneIndex}-n${i}`,
    edge: (i: number) => `s${sceneIndex}-e${i}`,
    // Connectors a template draws on its own account rather than for a specific
    // edge — a cycle's return arc, a tree's bracket, a timeline's axis. They
    // need ids of their own: reusing an edge id put two elements on the same id,
    // and `injectRevealTimes` finds elements by id.
    decoration: `s${sceneIndex}-dec`,
    caption: `s${sceneIndex}-cap`,
  };

  const plate = PLATES[diagram.shape](diagram, id);

  const html = [
    `<section class="sc-scene" data-scene="${sceneIndex}">`,
    `  <h2 class="sc-title" id="${id.title}">${escapeHtml(diagram.title)}</h2>`,
    `  <div class="sc-plate sc-plate-${diagram.shape}">`,
    plate,
    `  </div>`,
    ...(diagram.caption
      ? [`  <p class="sc-caption" id="${id.caption}">${escapeHtml(diagram.caption)}</p>`]
      : []),
    `</section>`,
  ].join('\n');

  return { html, anchors: anchorsIn(html) };
}

/**
 * The timeline, read back out of the markup that was just generated.
 *
 * Derived rather than assembled alongside it, because the two must agree and
 * assembling them separately does not guarantee that. Reveal times are keyed by
 * `elementId` and the renderer finds the element by `id`, so an anchor naming an
 * id the markup does not contain means that element never receives its time and
 * appears from the first frame regardless of what it was anchored to. Nothing
 * errors; the scene is simply mistimed, which is the kind of bug that survives
 * review. Templates differ in which edges they draw — a `timeline` renders an
 * axis where a `flow` renders one arrow per edge — so a hand-built list would
 * have to encode all twelve of those differences correctly.
 *
 * An element with no `data-on` lands at scene start, which is rule 4 in
 * `SceneTimeline`. That is right for a title and for a connector the template
 * drew on its own account.
 */
function anchorsIn(html: string): TimelineAnchor[] {
  return [...html.matchAll(/<[a-z][a-z0-9-]*\b[^>]*\bid="([^"]+)"[^>]*>/gi)].map((match) => {
    const phrase = /\bdata-on="([^"]*)"/i.exec(match[0])?.[1];
    return {
      elementId: match[1]!,
      phrase: phrase || undefined,
      draw: 'normal' as const,
      hold: true,
    };
  });
}

interface Ids {
  readonly title: string;
  readonly node: (i: number) => string;
  readonly edge: (i: number) => string;
  readonly decoration: string;
  readonly caption: string;
}

type Plate = (d: SceneDiagram, id: Ids) => string;

/** Keyed by every shape, so the lookup in `renderDiagram` is total. */
const PLATES: Record<DiagramShape, Plate> = {
  /** A becomes B becomes C, with a drawn arrow between each. */
  flow: (d, id) =>
    row(
      d.nodes.map((n, i) => box(n, id.node(i))),
      (i) => arrowRight(attr(id.edge(i - 1), d.edges[i - 1]?.anchor)),
    ),

  /**
   * The same row, plus the arc that closes it. The return is what makes it a
   * cycle rather than a flow, so it is drawn even when the model supplied no
   * closing edge — the shape itself asserts the loop.
   */
  cycle: (d, id) =>
    [
      row(
        d.nodes.map((n, i) => box(n, id.node(i))),
        (i) => arrowRight(attr(id.edge(i - 1), d.edges[i - 1]?.anchor)),
      ),
      // The closing edge, when the model named one, rides the return arc.
      `    ${returnArc(attr(id.decoration, d.edges[d.nodes.length - 1]?.anchor))}`,
    ].join('\n'),

  /** Two columns, one accent each. Exactly two, by SHAPE_LIMITS. */
  comparison: (d, id) =>
    `    <div class="sc-comparison">\n` +
    d.nodes
      .map(
        (n, i) =>
          `      <div class="sc-side ${i === 1 ? 'sc-side-b' : ''}" id="${id.node(i)}"${data(n)}>` +
          `<span class="sc-side-label">${escapeHtml(n.label)}</span>` +
          detail(n, 'sc-side-body') +
          `</div>`,
      )
      .join('\n') +
    `\n    </div>`,

  /** A root above, a bracket, and a row of children beneath it. */
  tree: (d, id) => {
    const [root, ...children] = d.nodes;
    if (!root) return '';
    return [
      `    <div class="sc-tree">`,
      `      <div class="sc-tree-root">${box(root, id.node(0))}</div>`,
      `      ${bracket(Math.max(children.length, 1), attr(id.decoration))}`,
      `      <div class="sc-tree-children">`,
      children.map((n, i) => `        ${box(n, id.node(i + 1))}`).join('\n'),
      `      </div>`,
      `    </div>`,
    ].join('\n');
  },

  /** Bordered boxes within bordered boxes, labelled at each level. */
  nested: (d, id) =>
    d.nodes.reduceRight(
      (inner, n, i) =>
        `    <div class="sc-nest sc-nest-${i}" id="${id.node(i)}"${data(n)}>\n` +
        `      <span class="sc-nest-label">${escapeHtml(n.label)}</span>\n` +
        (inner ? `${inner}\n` : '') +
        `    </div>`,
      '',
    ),

  /** Bands with no gap between them, so above and below read as adjacency. */
  stack: (d, id) =>
    `    <div class="sc-stack">\n` +
    d.nodes
      .map(
        (n, i) =>
          `      <div class="sc-layer" id="${id.node(i)}" data-enter="wipe"${data(n)}>` +
          `${escapeHtml(n.label)}${detail(n, 'sc-layer-detail')}</div>`,
      )
      .join('\n') +
    `\n    </div>`,

  /**
   * Bars in a shared track, drawn to real relative width.
   *
   * The width is a class rather than an inline style because the sanitizer
   * deletes `style=` attributes without failing a gate — which is exactly how
   * the previous implementation shipped bars of zero width.
   */
  proportion: (d, id) =>
    `    <div class="sc-proportion">\n` +
    d.nodes
      .map(
        (n, i) =>
          `      <div class="sc-bar-row" id="${id.node(i)}"${data(n)}>` +
          `<span class="sc-bar-label">${escapeHtml(n.label)}</span>` +
          `<span class="sc-track"><span class="sc-bar ${widthClass(n.value)}"></span></span>` +
          `</div>`,
      )
      .join('\n') +
    `\n    </div>`,

  /** A drawn axis with events marked along it. */
  timeline: (d, id) =>
    [
      `    <div class="sc-timeline">`,
      `      ${axis(d.nodes.length, attr(id.decoration))}`,
      `      <div class="sc-timeline-events">`,
      d.nodes
        .map(
          (n, i) =>
            `        <div class="sc-event" id="${id.node(i)}"${data(n)}>` +
            `<span class="sc-event-when">${escapeHtml(n.label)}</span>` +
            detail(n, 'sc-event-what') +
            `</div>`,
        )
        .join('\n'),
      `      </div>`,
      `    </div>`,
    ].join('\n'),

  /** Two dimensions crossing. Four cells, by SHAPE_LIMITS. */
  matrix: (d, id) =>
    [
      `    <div class="sc-matrix-frame">`,
      d.axes?.y ? `      <span class="sc-axis-y">${escapeHtml(d.axes.y)}</span>` : '',
      `      <div class="sc-matrix">`,
      d.nodes
        .map(
          (n, i) =>
            `        <div class="sc-cell${n.emphasis ? ' sc-em' : ''}" id="${id.node(i)}"${data(n)}>` +
            `${escapeHtml(n.label)}${detail(n, 'sc-cell-detail')}</div>`,
        )
        .join('\n'),
      `      </div>`,
      d.axes?.x ? `      <span class="sc-axis-x">${escapeHtml(d.axes.x)}</span>` : '',
      `    </div>`,
    ]
      .filter(Boolean)
      .join('\n'),

  /** The whole on one side, its named parts connected by leader lines. */
  parts: (d, id) => {
    const [whole, ...rest] = d.nodes;
    if (!whole) return '';
    return [
      `    <div class="sc-parts">`,
      `      <div class="sc-whole" id="${id.node(0)}"${data(whole)}>${escapeHtml(whole.label)}</div>`,
      `      <div class="sc-part-list">`,
      rest
        .map(
          (n, i) =>
            `        <div class="sc-part-row">${leader(attr(id.edge(i)))}` +
            `<span class="sc-part" id="${id.node(i + 1)}"${data(n)}>${escapeHtml(n.label)}</span></div>`,
        )
        .join('\n'),
      `      </div>`,
      `    </div>`,
    ].join('\n');
  },

  /** Terms and operators on one baseline, the result emphasised. */
  equation: (d, id) => {
    const operator = (i: number) =>
      d.edges.find((e) => e.from === d.nodes[i - 1]?.id && e.to === d.nodes[i]?.id)?.label ?? '+';
    return (
      `    <div class="sc-equation">\n` +
      d.nodes
        .map(
          (n, i) =>
            (i === 0 ? '' : `      <span class="sc-op">${escapeHtml(operator(i))}</span>\n`) +
            `      <span class="sc-term${n.emphasis ? ' sc-em' : ''}" id="${id.node(i)}"${data(n)}>` +
            `${escapeHtml(n.label)}</span>`,
        )
        .join('\n') +
      `\n    </div>`
    );
  },

  /**
   * A found picture, credited, with callouts naming what to look at.
   *
   * The only plate whose content is not drawn from the description — and the
   * only one that can be *empty*, when the search found nothing. That empty case
   * is deliberate and is caught upstream: the illustrator treats an image-less
   * illustration as a failed board and falls back, because a credit line under
   * a hole is worse than a plain diagram.
   *
   * `<img>` here is always a `data:` URI. `HtmlSanitizer` enforces that and
   * `BrowserPool` aborts anything else on the wire, so a remote URL does not
   * render slowly — it does not render at all.
   */
  illustration: (d, id) => {
    if (!d.image) return '';
    const callouts = d.nodes
      .map(
        (n, i) =>
          `        <li class="sc-callout" id="${id.node(i)}"${data(n)}>` +
          `<span class="sc-callout-label">${escapeHtml(n.label)}</span>` +
          detail(n, 'sc-callout-detail') +
          `</li>`,
      )
      .join('\n');

    return [
      `    <figure class="sc-figure${d.image.isPortrait ? ' sc-figure-portrait' : ''}">`,
      // No `data-on`: the picture is the board, so it is there from the first
      // frame and the callouts arrive on top of it. Anchoring the image itself
      // would leave the scene empty while the narration talked about it.
      `      <img class="sc-photo" id="${id.decoration}" ` +
        `src="${d.image.dataUri}" alt="${escapeHtml(d.image.alt)}">`,
      ...(d.nodes.length > 0
        ? [`      <ul class="sc-callouts">`, callouts, `      </ul>`]
        : []),
      `      <figcaption class="sc-credit">${escapeHtml(d.image.credit)}</figcaption>`,
      `    </figure>`,
    ].join('\n');
  },

  /** One idea stated large, with a drawn mark under it. */
  focus: (d, id) => {
    const only = d.nodes[0];
    if (!only) return '';
    return [
      `    <div class="sc-focus">`,
      `      <span class="sc-focus-text" id="${id.node(0)}" data-enter="scale"${data(only)}>` +
        `${escapeHtml(only.label)}</span>`,
      `      ${underline(attr(id.decoration))}`,
      `    </div>`,
    ].join('\n');
  },
};

/** A row of items with a connector between each adjacent pair. */
function row(items: readonly string[], connector: (i: number) => string): string {
  return (
    `    <div class="sc-row">\n` +
    items.map((item, i) => (i === 0 ? `      ${item}` : `      ${connector(i)}\n      ${item}`)).join('\n') +
    `\n    </div>`
  );
}

function box(node: DiagramNode, elementId: string): string {
  return (
    `<div class="sc-node${node.emphasis ? ' sc-em' : ''}" id="${elementId}"` +
    `${node.emphasis ? ' data-enter="scale"' : ''}${data(node)}>` +
    `${escapeHtml(node.label)}${detail(node, 'sc-node-detail')}</div>`
  );
}

function detail(node: DiagramNode, cls: string): string {
  return node.detail ? `<span class="${cls}">${escapeHtml(node.detail)}</span>` : '';
}

/** The anchor phrase, carried onto the element so the markup states its own timing. */
function data(node: { anchor?: string }): string {
  return node.anchor ? ` data-on="${escapeHtml(node.anchor)}"` : '';
}

/**
 * The attributes a drawn connector needs to participate in the timeline.
 *
 * The anchor has to reach the *markup*, not just an anchor list built beside it
 * — `anchorsIn` reads the phrase back off the element, so a connector without
 * `data-on` draws at scene start no matter what the model asked for.
 */
function attr(elementId: string, anchor?: string): string {
  return `id="${elementId}"${anchor ? ` data-on="${escapeHtml(anchor)}"` : ''}`;
}

/** Rounded to 5% so one small set of classes covers every bar. */
function widthClass(value: number | undefined): string {
  const pct = Math.round(Math.min(1, Math.max(0, value ?? 1)) * 20) * 5;
  return `sc-w-${pct}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
