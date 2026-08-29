/**
 * The base stylesheet every scene document carries.
 *
 * Deliberately small. It owns the board, the type scale, and what a reveal
 * *means* — nothing about layout or diagrams, which the storyboard author
 * decides per scene. This is the floor that guarantees a scene is legible even
 * if its own styles do very little.
 *
 * Reveal motion is driven entirely by the `--p` custom property that
 * `__seekTo` writes. There are no CSS animations or transitions anywhere here,
 * and there must not be: both advance against the wall clock, which would make
 * two renders of the same frame differ.
 */
export const BASE_STYLESHEET = String.raw`
* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  width: var(--frame-width);
  height: var(--frame-height);
  overflow: hidden;
  background: var(--board-bg);
}

body {
  font-family: var(--type-family), 'Kalam', system-ui, sans-serif;
  color: var(--ink-primary);
  line-height: var(--type-line-height);
  letter-spacing: var(--type-letter-spacing, 0em);
  /* Frames are composited as opaque video; sub-pixel antialiasing would make
     text fringe differently depending on what is behind it. */
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
}

.sc-board {
  width: 100%;
  height: 100%;
  padding: var(--board-padding);
  display: flex;
  flex-direction: column;
  gap: 1.2rem;
  overflow: hidden;
  /* Cross-fade between scenes. 1 unless the renderer is mid-transition, so a
     scene that is simply being drawn is unaffected. */
  opacity: var(--scene-opacity, 1);
}

/* A faint edge shadow, so the board reads as a surface rather than as a flat
   div. 'none' is the default and costs nothing; 'subtle' is the token's other
   documented value. */
html[data-vignette="subtle"] body::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 0 14rem rgba(0, 0, 0, 0.055);
}

.sc-scene {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
  width: 100%;
  height: 100%;
}

/* There is deliberately no universal font-size floor here, and there must not
   be one. A rule on .sc-scene * has the same specificity as every component
   rule, so when IDENTITY_LOCK restated it last it silently overrode all of
   them: every node, cell and layer rendered at min_rem regardless of the type
   scale, which is why boards looked small and uniform. The floor existed to
   stop a scene author setting tiny text, and scenes no longer write CSS — the
   renderer owns every size, and the theme's smallest token already sits above
   min_rem. */

.sc-title {
  font-size: var(--type-title);
  font-weight: 400;
  margin: 0;
  color: var(--ink-primary);
  text-wrap: balance;
}


.sc-callout {
  font-size: var(--type-body);
  color: var(--ink-accent);
  border-left: 4px solid var(--ink-accent);
  padding-left: 0.8em;
  margin: 0;
}

.sc-emphasis { color: var(--ink-accent); font-style: normal; }

/* ── Reveal ─────────────────────────────────────────────────────────────────
   Elements that carry a reveal time start hidden and arrive as --p goes 0 → 1.
   Anything without a reveal time is simply always visible.

   data-enter picks how it arrives. The default rise is the safe choice for
   text; the others exist because a title, a bullet and a diagram node arriving
   identically is what makes a video read as a template. */
[data-reveal-at] {
  --p: 0;
  opacity: var(--p);
  transform: translateY(calc((1 - var(--p)) * 0.5rem));
}

/* Scale-in, for emphasis. The seek script gives this one an overshoot curve, so
   it settles rather than stopping dead. */
[data-reveal-at][data-enter="scale"] {
  opacity: 1;
  transform: scale(calc(0.86 + 0.14 * var(--p)));
  transform-origin: center;
}

/* A wipe, for a band or a highlight: the element is revealed left-to-right
   without moving, which reads as a marker passing over it. */
[data-reveal-at][data-enter="wipe"] {
  opacity: 1;
  clip-path: inset(0 calc((1 - var(--p)) * 100%) 0 0);
}

/* No motion at all — appears at its moment. For anything where movement would
   be noise, like a table row. */
[data-reveal-at][data-enter="none"] {
  opacity: var(--p);
  transform: none;
}

/* A connector draws itself in rather than fading: it scales from its start edge
   as --p advances. The HTML approximation, for a straight rule between boxes;
   a real curve should use an SVG path, below. */
[data-reveal-at][data-draw] {
  opacity: 1;
  transform: scaleX(var(--p));
  transform-origin: left center;
}

/* ── Step focus ─────────────────────────────────────────────────────────────
   What makes a board *build* rather than just appear.

   A board is one diagram narrated over several scenes. Everything drawn in an
   earlier step stays on screen — that is the point, the viewer keeps the
   context — but it must stop competing for attention with the part being
   explained now. So an element recedes once its step is past: it desaturates
   towards the board and gives up some contrast, while keeping its position and
   its shape.

   Deliberately expressed as a filter rather than by overriding opacity or
   color. Every reveal rule above already owns one or both of those, and there
   are eight of them across HTML and SVG; a second declaration would have to
   fight each in turn, and the SVG stroke rules could not be expressed that way
   at all. filter composes with all of them, multiplying whatever the reveal
   left behind, so this rule is additive and none of the above changes.

   Applied only to elements the seek script has actually dimmed. An identity
   filter on every element would still force a compositing layer per element,
   and a board is drawn thousands of times. */
[data-dimmed] {
  filter:
    opacity(calc(1 - var(--step-dim-fade, 0.45) * var(--dim, 0)))
    saturate(calc(1 - var(--step-dim-desaturate, 0.8) * var(--dim, 0)));
}

/* An element whose step has not arrived. visibility, not display: the board is
   laid out once for the whole build and nothing may reflow as steps arrive, so
   a pending element still occupies its box. */
[data-step-pending] { visibility: hidden; }

/* ── SVG stroke drawing ─────────────────────────────────────────────────────
   The real hand-drawn primitive: a stroke advancing along its own geometry
   rather than a rectangle being stretched. pathLength="1" normalises every
   path to a unit length, so one rule covers any shape without measuring it —
   which is what keeps this deterministic and free of layout reads.

   Applies to any stroked SVG shape carrying a reveal time. */
svg [data-reveal-at],
svg[data-reveal-at] {
  opacity: 1;
  stroke-dasharray: 1;
  stroke-dashoffset: calc(1 - var(--p));
  transform: none;
}

/* A shape that should fill rather than draw opts out. */
svg [data-reveal-at][data-enter="fade"] {
  stroke-dasharray: none;
  stroke-dashoffset: 0;
  opacity: var(--p);
}

svg { overflow: visible; }

/* Pen geometry, from the theme. Scene styles set the colour; these decide what
   a drawn line looks like. */
/* Paths are strokes, not silhouettes. Stated on the element rather than on the
   sc- class, because the class-scoped version of this rule made a filled
   arrowhead unreachable: every storyboard class carries the sc- prefix, so
   nothing a scene could write beat it. Arrowheads are now drawn as stroked
   segments (see diagram/connectors.ts), and a shape that genuinely wants a fill
   simply does not use these elements. */
svg path, svg polyline { fill: none; }

svg .sc-stroke,
svg [class^="sc-"],
svg [class*=" sc-"] {
  stroke: var(--ink-accent-1);
  stroke-width: var(--stroke-width, 3px);
  stroke-linecap: var(--stroke-linecap, round);
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

/* The connector itself: a rule the scene can put between two boxes. Given a
   sensible default so a scene gets a usable arrow without restyling it. */
.sc-connector {
  flex: 0 0 auto;
  width: 4rem;
  height: 3px;
  background: var(--ink-accent-1);
  border-radius: 2px;
}

/* Vertical connectors grow downward instead. */
[data-reveal-at][data-draw="down"] {
  transform: scaleY(var(--p));
  transform-origin: top center;
}

.sc-connector-down {
  flex: 0 0 auto;
  width: 3px;
  height: 3rem;
  background: var(--ink-accent-1);
  border-radius: 2px;
}

/* ── Diagram layout ─────────────────────────────────────────────────────────
   Not defaults a scene may override — this *is* the layout. The markup is
   generated by infrastructure/render/diagram from a shape description, and
   every rule below is grid or flex, so the things on a board are siblings in
   normal flow. Overlap is therefore not a thing to detect; it is a thing the
   layout cannot produce.

   Nothing here positions absolutely. That is the single property worth
   protecting when adding a shape. */

.sc-plate {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  width: 100%;
}

.sc-caption {
  margin: 0;
  font-size: var(--type-label);
  color: var(--ink-secondary);
  text-align: center;
}

/* The one focal point, in the accent colour. SceneDiagram allows at most one. */
.sc-em { color: var(--ink-accent-1); border-color: var(--ink-accent-1); }

/* ── Nodes and connectors ─────────────────────────────────────────────────── */

.sc-row {
  display: flex;
  align-items: stretch;
  justify-content: center;
  gap: 0.7rem;
  width: 100%;
  min-height: 10rem;
}

/* Nodes share the row rather than huddling in the middle of it.
   Growing them with a max-width is what makes a board fill its frame: sized
   purely to their content, three boxes occupied a third of a 1280px board and
   the result read as an empty slide with something small in the centre. */
.sc-node {
  flex: 1 1 0;
  min-width: 7rem;
  max-width: 22rem;
  min-height: 8rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  border: var(--stroke-width, 3px) solid var(--ink-primary);
  border-radius: var(--stroke-radius, 12px);
  padding: 1.4rem 1.6rem;
  font-size: var(--type-body);
  text-align: center;
}

.sc-node-detail, .sc-layer-detail, .sc-cell-detail, .sc-event-what, .sc-side-body {
  font-size: var(--type-label);
  color: var(--ink-secondary);
}

.sc-conn { flex: 0 0 3.4rem; height: 2.2rem; align-self: center; }

/* ── flow / cycle ─────────────────────────────────────────────────────────── */

.sc-plate-cycle { gap: 0; }
.sc-return-arc { width: 100%; height: 4.5rem; }

/* ── comparison ───────────────────────────────────────────────────────────── */

.sc-comparison {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2.5rem;
  width: 100%;
}
.sc-side {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  border-top: 8px solid var(--ink-accent-1);
  padding: 1.5rem 0.2rem 0;
  min-height: 13rem;
  font-size: var(--type-label);
}
.sc-side-b { border-top-color: var(--ink-accent-2); }
.sc-side-label { font-size: var(--type-body); }

/* ── tree ─────────────────────────────────────────────────────────────────── */

.sc-tree { display: flex; flex-direction: column; width: 100%; gap: 0; }
.sc-tree-root { display: flex; justify-content: center; }
.sc-bracket { width: 100%; height: 4rem; }
/* No column gap, and the separation comes from a margin inside each column
   instead. The bracket drops at (i + 0.5) / count of its own width, so a grid
   gap moves the boxes' centres inward and the arrows land beside them rather
   than on them. Margins keep the column centres where the connector expects. */
.sc-tree-children {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 0;
  justify-items: stretch;
}
.sc-tree-children > * { margin: 0 0.5rem; }

/* ── nested ───────────────────────────────────────────────────────────────── */

.sc-nest {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1.1rem;
  border: 3px solid var(--ink-muted);
  border-radius: 14px;
  padding: 1.3rem;
}
.sc-nest-0 { border-color: var(--ink-primary); }
.sc-nest-1 { border-color: var(--ink-accent-1); }
.sc-nest-2 { border-color: var(--ink-accent-2); }
.sc-nest-label { font-size: var(--type-body); }

/* ── stack ────────────────────────────────────────────────────────────────── */

.sc-stack { display: flex; flex-direction: column; width: min(80%, 720px); }
.sc-layer {
  border: 2px solid var(--ink-muted);
  padding: 1.5rem 1.6rem;
  font-size: var(--type-body);
}

/* ── proportion ───────────────────────────────────────────────────────────── */

.sc-proportion { display: flex; flex-direction: column; gap: 1.6rem; width: min(88%, 940px); }
.sc-bar-row { display: flex; align-items: center; gap: 1.2rem; font-size: var(--type-label); }
.sc-bar-label { flex: 0 0 10em; font-size: var(--type-label); }
.sc-track {
  display: block;
  flex: 1;
  height: 2.4rem;
  border: 2px solid var(--ink-muted);
  border-radius: 999px;
  overflow: hidden;
}
.sc-bar { display: block; height: 100%; background: var(--ink-accent-1); }

/* Bar widths are classes, not inline styles: HtmlSanitizer deletes style
   attributes and does not fail a gate for it, so an inline width renders as a
   zero-width bar with nothing reporting why. */
.sc-w-0 { width: 0%; }
.sc-w-5 { width: 5%; }
.sc-w-10 { width: 10%; }
.sc-w-15 { width: 15%; }
.sc-w-20 { width: 20%; }
.sc-w-25 { width: 25%; }
.sc-w-30 { width: 30%; }
.sc-w-35 { width: 35%; }
.sc-w-40 { width: 40%; }
.sc-w-45 { width: 45%; }
.sc-w-50 { width: 50%; }
.sc-w-55 { width: 55%; }
.sc-w-60 { width: 60%; }
.sc-w-65 { width: 65%; }
.sc-w-70 { width: 70%; }
.sc-w-75 { width: 75%; }
.sc-w-80 { width: 80%; }
.sc-w-85 { width: 85%; }
.sc-w-90 { width: 90%; }
.sc-w-95 { width: 95%; }
.sc-w-100 { width: 100%; }

/* ── timeline ─────────────────────────────────────────────────────────────── */

.sc-timeline { display: flex; flex-direction: column; width: 100%; gap: 0.4rem; }
.sc-axis { width: 100%; height: 2rem; }
/* Same rule as the tree: the axis ticks are drawn at the column centres, so
   the columns must actually be equal. */
.sc-timeline-events {
  min-height: 8rem;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 0;
  justify-items: center;
}
.sc-timeline-events > * { padding: 0 0.5rem; }
.sc-event { display: flex; flex-direction: column; align-items: center; gap: 0.3rem; text-align: center; font-size: var(--type-label); }
.sc-event-when { font-size: var(--type-body); color: var(--ink-accent-1); }
.sc-timeline-events { padding-top: 0.2rem; }

/* ── matrix ───────────────────────────────────────────────────────────────── */

.sc-matrix-frame {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.7rem 1rem;
  align-items: center;
  width: min(80%, 780px);
}
.sc-axis-y { font-size: var(--type-label); color: var(--ink-secondary); writing-mode: vertical-rl; transform: rotate(180deg); }
.sc-axis-x { grid-column: 2; font-size: var(--type-label); color: var(--ink-secondary); text-align: center; }
.sc-matrix {
  grid-column: 2;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
}
.sc-cell {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.25rem;
  min-height: 9rem;
  border: 2px solid var(--ink-muted);
  padding: 1.1rem 1.3rem;
  font-size: var(--type-body);
}

/* ── parts ────────────────────────────────────────────────────────────────── */

.sc-parts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 1.6rem;
  align-items: center;
  width: 100%;
}
.sc-whole {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 14rem;
  min-height: 11rem;
  border: var(--stroke-width, 3px) solid var(--ink-primary);
  border-radius: var(--stroke-radius, 12px);
  padding: 2rem 1.8rem;
  font-size: var(--type-body);
  text-align: center;
}
.sc-part-list { display: flex; flex-direction: column; gap: 0.9rem; }
.sc-part-row { display: flex; align-items: center; gap: 0.3rem; }
.sc-leader { flex: 0 0 3rem; height: 1rem; }
.sc-part {
  font-size: var(--type-body);
  color: var(--ink-secondary);
  border-bottom: 2px solid var(--ink-muted);
  padding-bottom: 0.2rem;
}

/* ── equation ─────────────────────────────────────────────────────────────── */

.sc-equation {
  min-height: 9rem;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 0.9rem;
  font-size: var(--type-body);
}
.sc-term { font-size: calc(var(--type-title) * 0.72); }
.sc-op { font-size: calc(var(--type-title) * 0.6); color: var(--ink-muted); }

/* ── focus ────────────────────────────────────────────────────────────────── */

.sc-focus { display: flex; flex-direction: column; align-items: center; gap: 0.7rem; max-width: 84%; }
.sc-focus-text { font-size: var(--type-title); text-align: center; line-height: 1.25; }
.sc-underline { width: 100%; height: 0.9rem; }

/* ── illustration ─────────────────────────────────────────────────────────── */

/* The one plate whose content is a photograph rather than drawn marks, so it is
   the one place a hard size cap matters: an image is the only element on a board
   that arrives with its own intrinsic dimensions and will happily push the
   callouts and the credit line out of frame. The max-height is in viewport
   units rather than pixels because the preset decides the frame. */
.sc-figure {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  justify-items: center;
  gap: 0.8rem;
  width: 100%;
  margin: 0;
}
/* A portrait image beside its callouts rather than above them — stacked, it
   leaves two columns of empty board and a picture too small to read. */
.sc-figure-portrait { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); align-items: center; }

.sc-photo {
  max-width: 100%;
  max-height: 58vh;
  object-fit: contain;
  /* The frame is what makes a rectangular photograph sit on a hand-drawn board
     rather than float above it. */
  border: var(--stroke-width, 3px) solid var(--ink-muted);
  border-radius: var(--stroke-radius, 12px);
}
.sc-figure-portrait .sc-photo { max-height: 66vh; }

/* Traced strokes stand in for the picture, so they take the picture's box —
   including the height cap, which is the one thing that keeps an image from
   pushing the callouts and the credit line out of frame. The fill:none is not
   optional: a traced boundary is a closed path, and filled it renders as a
   silhouette. */
.sc-trace {
  width: 100%;
  max-height: 58vh;
  overflow: visible;
}
.sc-figure-portrait .sc-trace { max-height: 66vh; }
.sc-trace path {
  fill: none;
  stroke: var(--ink-primary);
  stroke-width: 1.4;
  stroke-linecap: var(--stroke-linecap, round);
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.sc-callouts { display: flex; flex-direction: column; gap: 0.6rem; list-style: none; padding: 0; margin: 0; }
.sc-figure-portrait .sc-callouts { align-items: flex-start; }
.sc-figure:not(.sc-figure-portrait) .sc-callouts { flex-direction: row; flex-wrap: wrap; justify-content: center; }

.sc-callout {
  font-size: var(--type-label);
  color: var(--ink-secondary);
  border-left: var(--stroke-width, 3px) solid var(--ink-accent);
  padding-left: 0.5rem;
}
.sc-callout-label { font-size: var(--type-body); color: var(--ink-primary); }
.sc-callout-detail { display: block; color: var(--ink-secondary); }

/* Credit is a licence obligation, not decoration — every source this service
   searches requires it. Small and muted, never absent: see SceneImage. */
.sc-credit {
  grid-column: 1 / -1;
  font-size: var(--type-label);
  color: var(--ink-muted);
  text-align: center;
}
`;

/**
 * Rules a scene may not override.
 *
 * Inlined *after* the scene's own style block, so it wins at equal specificity.
 * Everything else is a floor a scene can raise; these are the video's identity,
 * and a scene that restyles them makes its board look like it belongs to a
 * different video.
 *
 * Observed in a real run: scenes set their own `font-family`, losing the
 * handwriting face, and their own `.sc-title` size, ending up with titles
 * *smaller* than body text on every board.
 */
export const IDENTITY_LOCK = String.raw`
/* The handwriting face is the video's identity, and the theme defines exactly
   one. Locked across the whole subtree rather than just the board: a scene that
   set its own family on a card turned that card into what looked like a code
   listing sitting in a handwritten video. */
body, .sc-board, .sc-scene, .sc-scene * {
  font-family: var(--type-family), 'Kalam', system-ui, sans-serif;
}

/* Titles are the top of a fixed type scale, not a per-scene choice. */
.sc-scene > .sc-title,
.sc-board .sc-title {
  font-size: var(--type-title);
  line-height: 1.15;
  color: var(--ink-primary);
}

.sc-scene > .sc-title { font-size: var(--type-title); }
`;
