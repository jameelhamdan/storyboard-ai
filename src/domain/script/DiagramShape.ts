/**
 * The shape a scene's picture takes.
 *
 * This used to be free text — the script model wrote a sentence like "show the
 * process" and the storyboard model read it, which meant nobody ever committed
 * to a diagram. A scene with no decided shape reliably came back as a title and
 * a bullet list, because that is what prose degrades into.
 *
 * Making it an enum forces the choice at the stage that actually knows the
 * material, and hands the illustrator a concrete target instead of an adjective.
 *
 * Every entry is a shape an explanation genuinely has. There is deliberately no
 * `list` and no `none`: a board of text is the failure this project exists to
 * avoid, so the vocabulary does not contain a way to ask for one.
 */
export const DIAGRAM_SHAPES = [
  'flow',        // something becomes something else, in order
  'cycle',       // it returns to where it started
  'comparison',  // two things differ
  'tree',        // something classifies or branches
  'nested',      // something contains something
  'stack',       // layers, where above and below mean something
  'proportion',  // one quantity dwarfs another
  'timeline',    // things happen at times
  'matrix',      // two dimensions cross
  'parts',       // a whole has named parts
  'equation',    // quantities combine into a result
  'focus',       // one idea, stated large — the honest answer for a definition
  'illustration',// the thing itself, photographed or diagrammed, with callouts
] as const;

export type DiagramShape = (typeof DIAGRAM_SHAPES)[number];

/**
 * What each shape is for, in the words the model is given.
 *
 * Kept next to the enum rather than in the prompt file so the two cannot drift:
 * a shape added here appears in the prompt automatically, and the contract test
 * asserts the prompt lists exactly these.
 *
 * These describe **meaning, not markup**. They used to name boxes, rings and
 * SVG paths, from when the model drew its own board; it now describes what the
 * picture says and the renderer decides how that is drawn. Saying "boxes around
 * a ring" here would be describing a layout the templates do not produce.
 */
export const SHAPE_GUIDANCE: Readonly<Record<DiagramShape, string>> = Object.freeze({
  flow: 'A becomes B becomes C, in order. Each node is a stage; each edge is the step between two of them.',
  cycle: 'It comes back to where it started. Same as a flow, plus the return — the last node leads to the first.',
  comparison: 'Two things differ. Exactly two nodes, one per side; the label names each side and the detail says how it differs.',
  tree: 'One thing classifies into several. The first node is the root; the rest are what it branches into.',
  nested: 'One thing is inside another. Nodes are given outermost first, each contained by the one before it.',
  stack: 'Layers where above and below mean something. Nodes are given top to bottom, and the order is the meaning.',
  proportion: 'One quantity dwarfs another. Every node needs a `value` between 0 and 1 — the real relative size, not a guess.',
  timeline: 'Things happen at times. The label is when, the detail is what happened.',
  matrix: 'Two dimensions cross. Exactly four nodes, read left-to-right then top-to-bottom, with `axes` naming the two dimensions.',
  parts: 'A whole has named parts. The first node is the whole; the rest are its parts.',
  equation: 'Quantities combine into a result. Nodes are the terms; an edge label is the operator between two of them.',
  focus: 'One idea, stated large. A single node whose label is the idea itself. For a definition that has no other shape.',
  illustration: 'The thing itself, shown. A real photograph or a published scientific diagram, found by search rather than drawn, with short callouts naming what to look at. For a subject whose appearance *is* the information — an organ, an instrument, a rock formation, a circuit — where a box-and-arrow abstraction would throw away the part that teaches.',
});

/**
 * How many nodes each shape can hold and still lay out well.
 *
 * These are the real constraints of the templates in
 * `infrastructure/render/diagram`, stated once here so the prompt, the schema
 * validation and the renderer cannot disagree about them. A `comparison` with
 * three columns is not a tighter fit, it is a different shape.
 *
 * The maxima are what fits in 1280x720 at the theme's type scale with room to
 * breathe — the board is allowed to look sparse and is not allowed to look
 * crowded, which is the trade the upper bounds encode.
 *
 * `labelWords` is a diagram-label budget, not a sentence budget: a node beside
 * three others has room for a name and nothing more. `focus` is the exception
 * because its single node *is* the board — it states one idea large, so it gets
 * room for a clause.
 */
export const SHAPE_LIMITS: Readonly<
  Record<DiagramShape, { min: number; max: number; labelWords: number }>
> =
  Object.freeze({
    flow: { min: 2, max: 4, labelWords: 4 },
    cycle: { min: 2, max: 4, labelWords: 4 },
    comparison: { min: 2, max: 2, labelWords: 4 },
    tree: { min: 2, max: 5, labelWords: 4 },
    nested: { min: 2, max: 3, labelWords: 4 },
    stack: { min: 2, max: 5, labelWords: 4 },
    proportion: { min: 2, max: 4, labelWords: 4 },
    timeline: { min: 2, max: 5, labelWords: 4 },
    matrix: { min: 4, max: 4, labelWords: 4 },
    parts: { min: 2, max: 5, labelWords: 4 },
    equation: { min: 2, max: 4, labelWords: 4 },
    focus: { min: 1, max: 1, labelWords: 14 },
    /**
     * Callouts, not content: the picture carries the scene, and each node is a
     * label pointing into it. Zero is allowed — a photograph that needs no
     * annotation is a complete board — and four is what fits beside the plate
     * without crowding the image it is annotating.
     */
    illustration: { min: 0, max: 4, labelWords: 4 },
  });

/** Unknown or missing input falls back to the shape that is never wrong. */
export function toDiagramShape(raw: string | undefined): DiagramShape {
  const value = (raw ?? '').trim().toLowerCase();
  return (DIAGRAM_SHAPES as readonly string[]).includes(value)
    ? (value as DiagramShape)
    : 'focus';
}
