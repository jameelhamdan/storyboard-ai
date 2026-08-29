# Board Contract

What a board is, how it is timed, and what may appear on it.

**The model no longer writes markup.** It returns a `SceneDiagram` — a shape, a title, nodes, edges
and anchors, with no coordinates and no CSS — and `src/infrastructure/render/diagram/` lays it out.
This replaced free-form HTML authoring, and the replaced version is worth remembering: the model
wrote its own positions, nothing in the system measured the result, and a board whose centre box
covered the label beside it passed every quality gate.

The pattern gallery that used to live here is gone with it. It documented markup a model was expected
to imitate; the thirteen templates are the contract now, and
`test/integration/diagram-layout.test.ts` renders every one of them in a real browser and asserts
nothing overlaps, nothing clips and nothing falls below the legibility floor.

---

## 1. A board, and the scenes on it

**A board is one diagram and the consecutive scenes narrated over it.** Most boards span more than
one: the diagram is laid out once, in full, and revealed a **step** at a time — step *N* arrives while
the *N*th scene is spoken, takes the focus, and everything already drawn stays on screen and recedes.

That is the whole point. A video whose every scene wipes to a fresh board makes the viewer rebuild the
context each time; a board that grows keeps the thing being explained in view while the narration
walks around it. A board of one scene behaves exactly as a scene did before boards existed.

The script stage decides where boards break, by marking a scene `continuesBoard`. Two rules override
that mark, and `groupIntoBoards` is where both live:

- **The shapes must agree.** A board is one diagram; a scene cannot continue a `flow` as a `matrix`.
- **A board may not have more steps than its shape has room for.** Every step must add at least one
  node or edge, and a shape's node limit is for the *whole board* — so `focus` (one node) is always a
  single scene and `comparison` (two) holds at most two.

**The node budget does not grow with the build.** A shape's limit is a layout constraint — what fits
without crowding — so a four-node `flow` narrated over three scenes is still four nodes. The steps
decide *when* parts arrive, not how many there are.

A step changes an element's `visibility` and never its box, so **the board's geometry is identical at
every step**. That is what lets the collision and legibility checks measure a board once and have the
answer hold for the whole build.

---

## 2. The contract

A board is described, not drawn:

```ts
{
  shape: 'cycle',                     // one of thirteen, chosen by the script stage
  title: 'Charging and discharging are one loop',
  steps: 2,                           // one per scene on this board
  nodes: [
    { id: 'cat', label: 'Cathode', anchor: 'Charging moves',   step: 1 },
    { id: 'an',  label: 'Anode',   anchor: 'lithium one way',  step: 2 },
  ],
  edges: [{ from: 'cat', to: 'an', label: 'charging', step: 2 }],
  caption: 'The cell arrives back where it started.',
}
```

- **`shape`** comes from the script stage, which read the whole source document. The illustrator
  fills it; it does not get to change it.
- **`illustration` is the one shape that does not draw itself.** Instead of nodes and edges it
  carries an `imageBrief` — search terms and a `kind` of `photo` or `diagram` — and the pipeline
  goes and finds the picture: Wikimedia Commons for published scientific figures, Unsplash and
  Pexels for photographs. The found image is resized, re-encoded and **inlined as a `data:` URI**,
  because the renderer aborts every request whose scheme is not `data:` and a remote URL would
  render as nothing. Its nodes become callouts pointing into the picture, and the credit line under
  it is a licence obligation rather than decoration. See §7.
- **`nodes` / `edges`** are validated by `SceneDiagram`: ids resolve, counts sit inside the shape's
  `SHAPE_LIMITS`, labels are short enough to be labels, every step from 1 to `steps` adds something,
  and at most one node is emphasised **per step**. A diagram that violates any of it is rejected
  rather than repaired, because the retry path exists to ask properly.
- **`step`** is which part of the build an element belongs to. It is also a *hard gate on
  visibility*: an element never inks before its step, whatever its anchor resolved to. An anchor that
  fails to match inherits the previous element's time, and without the gate that could put a step-3
  node on screen during step 1 — giving the ending away. The gate bounds a missed anchor to
  mistiming within its own step.
- **`emphasis` is per step**, not per board, because the focus is exactly what moves as the
  explanation advances.
- **No positions, no sizes, no colours, no CSS.** Overlap is not something to detect; it is something
  the format cannot express.

Everything else — the frame, the palette, the type scale, the stroke weight — comes from the theme.

---

## 3. Timing — word-anchored

The model never writes a time. It writes **which phrase in the narration** an element appears on, and
the renderer resolves that against the TTS word timings.

```
data-on="light reactions"   →  phrase lookup in narration
                            →  word timing from TTS  (2.10s)
                            →  frame                 (2.10 × 24 = 50)
```

The model supplies the phrase as a node's or edge's `anchor`; `renderDiagram` emits it as `data-on`
alongside the `id` the reveal time is stamped on. Both attributes still exist in the markup and mean
what they always did — only who writes them changed.

| Attribute | Meaning |
|---|---|
| `id` | On every anchorable element. How the renderer finds it to stamp a time on. |
| `data-on` | Reveal when this phrase is spoken. Must be a **verbatim substring** of the narration of the element's **own step**. |
| `data-step` | Which step of the build the element belongs to. Stamped on every element of a built board, omitted entirely on a single-step one. |

**Resolution rules:**

1. Phrase match is case-insensitive and whitespace-normalised.
2. A repeated phrase resolves to its **first** occurrence.
3. An unmatched phrase inherits the previous element's time and records a warning. More than one
   unmatched anchor *within a scene's own step* fails the board.
4. No `data-on` means visible from the start of the element's step.
5. Reveal order is resolved time, not document order — an impossible sequence cannot be authored.
6. **A step never inks early**, whatever rule 3 resolved to. The gate is absolute.

**Each scene resolves only its own step's anchors**, against its own measured word timings — those
phrases appear in that scene's narration and nowhere else. The page, however, spans the whole board
and is seeked on the *board's* clock, so the resolved times are rebased by the scene's offset within
the board before they are stamped. Getting that wrong fails nothing; it draws the right element at
the wrong moment.

> **The narration you receive is already the spoken form.** Numerals, symbols and abbreviations are
> expanded to how they will be pronounced (`50%` → `fifty percent`) *before* this stage, so the text
> in your prompt is byte-identical to what the synthesiser speaks and what its word timings are keyed
> on. Anchor against exactly that. Subtitles are rendered from the original written form, so viewers
> still read `50%` — that mapping is the renderer's problem, not yours.

---

## 4. Motion

Anchored elements rise and fade as they arrive. That is the default and it is automatic.

**How an element arrives** — `data-enter`:

| Value | Motion | For |
|---|---|---|
| *(omitted)* | rise + fade | body text, list items |
| `scale` | grows into place, settles with a slight overshoot | the focal point, a result, a number |
| `wipe` | revealed left-to-right, no movement | a highlight passing over something |
| `none` | appears | a table row, where movement is noise |

**How fast** — each anchor carries a `draw` speed (`fast` / `normal` / `slow`). It reaches the page
as `data-draw-speed` and scales that element's duration against `motion.reveal_ms`.

**Lines draw themselves.** An SVG `<path>` with `pathLength="1"` and a reveal time advances its
stroke along its own geometry. This is the primitive that makes the video read as drawn, and the
`pathLength` is not optional: the reveal rule sets `stroke-dasharray: 1`, so a path without it gets a
one-user-unit dash pattern and renders as a dotted crumb. Arrowheads are extra stroked segments in
the same `d`, so they draw with the shaft — see `render/diagram/connectors.ts`.

**Siblings stagger.** Elements resolving to the same moment are offset by `motion.stagger_ms` in
document order, so a list arrives in sequence rather than as a block. Automatic — the offset is
computed when the document is built, so it is identical on every render.

**The focus moves between steps.** When a step ends, everything in it recedes — desaturating and
giving up some contrast over roughly twice `motion.reveal_ms` — while the arriving step stays at full
ink. Expressed as a CSS `filter` rather than by overriding `opacity` or `color`, so it composes with
whatever reveal rule the element already uses instead of fighting eight of them in turn.

Elements keep their position and their box throughout. Nothing reflows as a board builds.

**Boards cross-fade** into one another over a short window at each boundary — a dip: the outgoing
board fades down to the background and the incoming one fades up from it, since only one document is
ever loaded. Those frames are the only ones in the video that are neither a reveal nor a still, and
each has to be drawn, which is why the window is short.

**Boards, not scenes.** A wipe means *new diagram*. Inside a board nothing fades, because the
continuity is the point — which is also why a board narrated over four scenes now pays for one
transition rather than four.

Everything holds still once it has arrived and stopped receding. Nothing drifts, pulses or loops. All
of it is a pure function of the frame number: a segment re-rendered on another worker is
pixel-identical.

---

## 5. Legibility

Non-negotiable, because the output is 720p and may be watched on a phone.

- Body text never below `theme.type.min_rem`. **Measured** — Stage A reads the computed font size of
  every inked element off the laid-out page.
- Contrast at least 4.5:1 against the board.
- Nothing overlaps and nothing leaves the frame. Also measured, and not by a model: see
  `render/page/measure.ts`. A vision judge missed exactly this and passed the board with a 4.
- Node counts per shape come from `SHAPE_LIMITS`, which is what the templates can lay out well.
  Beyond that, the scene should have been split.
- Diagram labels 1–4 words. Longer belongs in the narration. `focus` is the exception: its single
  node is the board.
- Leave generous empty space. The board is not a slide to fill.

---

## 6. Grounding

- **Every visible word must be faithful to the source.** A label is one to four words, so it is
  necessarily shorter than the sentence it came from — shortening is not paraphrasing, and "the
  anode" for "the anode is the negative electrode" is correct. What is not allowed is a label that
  states something the source does not: a different claim, an invented figure, or a compression that
  changes the meaning.
- **A relationship may only be drawn where the source states it.** An edge from A to B claims the
  source said A leads to B. Proximity in the text is not a stated relationship. Fewer, correct
  connections beat more, invented ones.
- **When an idea has no shape, it is `focus`** — the one idea stated large with a drawn mark under
  it. That is still a drawing. There is no `list` and no `none`, because a board of text is the
  failure this project exists to avoid.

---

---

## 7. Found images

`illustration` exists because some subjects are their appearance. What a mitral valve, an
oscilloscope trace or a basalt column actually looks like is the thing being taught, and a
box-and-arrow abstraction of it throws away the part that teaches. Everything else on the board —
title, callouts, credit, motion — works exactly as it does for a drawn shape.

**The feature is on when a library is configured and off when none is.** With no
`UNSPLASH_ACCESS_KEY`, no `PEXELS_API_KEY` and `WIKIMEDIA_IMAGES=false`, the script stage is never
offered the shape, so a deployment with no keys behaves exactly as it did before the shape existed.
A caller can also turn it off per job with `features.images: false`.

**Search is routed, not ranked.** `kind: 'diagram'` starts at Wikimedia Commons and `kind: 'photo'`
starts at the stock libraries, each falling through to the others. The libraries are not
interchangeable: Commons has the Krebs cycle and few good photographs, and a stock search for the
Krebs cycle returns a photograph of a laboratory bench. That routing is a domain policy
(`ImageSourcePolicy`), not a rule inside the adapter that iterates the sources — which is what lets a
new library be a new file plus a registration.

**A job chooses its libraries.** `features.image_sources` on the request names them in preference
order, and the job gets the intersection with what the deployment can reach. See
`docs/api-contract.md`.

**Nothing on a board is generated imagery.** A picture is either drawn by the renderer from a
described `SceneDiagram`, or it is a real photograph or published figure that already existed and is
credited to whoever made it. There is no image-generation model in this service and no
`ImageSourceId` for one, so there is no way to ask for one.

**A found diagram draws itself.** Line art is traced into SVG strokes — contours measured once at
storyboard time, stored in the scene's markup, revealed by the same `pathLength="1"` mechanism as
every other line on the board. So the picture is *written* rather than switched on, which is the
whole aesthetic. This invents nothing: the contours are the ones already in the image, so what gets
drawn is the published figure the credit line names.

Tracing happens once and never per frame — every frame stays a pure function of the frame number, so
a segment re-rendered on another worker is still pixel-identical and resume still works. A photograph
is never traced: it produces hundreds of fragments of shadow and texture, so a trace that comes back
looking like that is discarded and the picture is shown as found, present from the first frame with
the callouts arriving over it.

**Failure is a fallback, not a broken board.** If nothing is found the scene falls back to the
built-in board and the substitution is recorded — an `illustration` plate with no picture would
render as a credit line under a hole.

**Every image is credited.** Author, source and licence travel on the same object as the pixels, and
`SceneImage` refuses to exist without them.
