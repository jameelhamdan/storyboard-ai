import { SHAPE_LIMITS, toDiagramShape, type DiagramShape } from './DiagramShape.js';
import type { SceneImage } from '@domain/media/SceneImage.js';

/**
 * Which step of the board's build an element belongs to.
 *
 * 1-based, and it indexes the board's *scenes*: step 1 is drawn while the first
 * scene is narrated, step 2 while the second, and so on. It is what makes a
 * board accumulate instead of being replaced — the whole diagram is laid out
 * once, and the steps decide what has arrived yet and what the viewer should be
 * looking at now. Elements from earlier steps stay on the board and recede;
 * later steps are not drawn yet.
 *
 * A single-scene board has one step, which is the old behaviour exactly.
 */
export type DiagramStep = number;

export interface DiagramNode {
  readonly id: string;
  /** Short — the shape decides how short. Longer belongs in the narration. */
  readonly label: string;
  /** An optional second line, for a shape whose template has room for one. */
  readonly detail?: string;
  /** 0–1, for `proportion` only: the share of the track this bar fills. */
  readonly value?: number;
  /** Draws this node in the accent colour. At most one per *step*. */
  readonly emphasis?: boolean;
  /** Verbatim phrase from the spoken narration that this node arrives on. */
  readonly anchor?: string;
  /** Which step of the build this arrives in. Defaults to 1. */
  readonly step?: DiagramStep;
}

export interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  /** A word or two riding the connector — `charging`, `+`, `then`. */
  readonly label?: string;
  readonly anchor?: string;
  /** Which step of the build this arrives in. Defaults to 1. */
  readonly step?: DiagramStep;
}

export interface DiagramAxes {
  readonly x?: string;
  readonly y?: string;
}

/**
 * What to go and find, for the one shape that does not draw its own picture.
 *
 * `kind` routes the search rather than describing it. A photograph and a
 * published scientific diagram live in different libraries — stock has
 * beautiful pictures of laboratories and nothing at all of the Krebs cycle,
 * Wikimedia has the Krebs cycle and few beautiful pictures — so a scene that
 * needs the mechanism and a scene that needs the object are two different
 * searches, and asking for both in one query reliably returns the stock photo.
 */
export interface ImageBrief {
  /** Search terms, not a sentence. `human heart cross section anatomy`. */
  readonly query: string;
  readonly kind: 'photo' | 'diagram';
  /** What the picture shows, for the alt text and for a judge reading it. */
  readonly alt: string;
}

const MAX_TITLE_CHARS = 60;

/**
 * What a scene's board contains — with no statement about where anything sits.
 *
 * This replaces model-authored HTML, and the omission is the entire point. The
 * storyboard model used to write its own CSS and position its own elements,
 * which it is bad at: a real run shipped a board whose centre box covered the
 * label beside it, and every gate passed because nothing in the system measured
 * geometry. Positions are now computed by the renderer from this description,
 * so overlap is not something to detect — it is something the format cannot
 * express.
 *
 * The second reason is cost. A spec is a few hundred output tokens where the
 * equivalent HTML was a few thousand, and the judge stops paying for
 * regenerations of boards that were only ever wrong about layout.
 *
 * A node's `anchor` is a verbatim phrase from the scene's spoken narration, and
 * carries exactly the meaning it did before — see `SceneTimeline`, which
 * resolves it against measured word timings. Nothing about the reveal path
 * changed.
 */
export class SceneDiagram {
  private constructor(
    public readonly shape: DiagramShape,
    public readonly title: string,
    public readonly nodes: readonly DiagramNode[],
    public readonly edges: readonly DiagramEdge[],
    public readonly caption: string | undefined,
    public readonly axes: DiagramAxes | undefined,
    /** What to search for. Present on `illustration` and nothing else. */
    public readonly imageBrief: ImageBrief | undefined,
    /** The found image. Attached after validation — see `withImage`. */
    public readonly image: SceneImage | undefined,
    /** How many scenes this board builds over. 1 is a board that arrives at once. */
    public readonly steps: number,
  ) {}

  /**
   * Validate a model-supplied description into something the renderer can draw.
   *
   * Throws rather than repairing. A diagram that violates its own shape's
   * limits is a scene the model misjudged, and the storyboard stage already has
   * a retry path that tells it what went wrong — silently dropping the fifth
   * node of a two-column comparison would ship a board missing half its content
   * with nothing recorded to explain it.
   */
  public static of(input: {
    shape: string | undefined;
    title: string;
    nodes: readonly DiagramNode[];
    edges?: readonly DiagramEdge[];
    caption?: string;
    axes?: DiagramAxes;
    imageBrief?: ImageBrief;
    /**
     * How many steps this board builds over — its scene count. Defaults to 1,
     * which is a board that arrives all at once, exactly as before.
     */
    steps?: number;
  }): SceneDiagram {
    const shape = toDiagramShape(input.shape);
    const title = input.title.trim();
    if (!title) throw new Error('Diagram title is empty.');
    if (title.length > MAX_TITLE_CHARS) {
      throw new Error(`Diagram title is ${title.length} characters; the limit is ${MAX_TITLE_CHARS}.`);
    }

    /**
     * An `illustration` with nothing to look for is a title and some labels —
     * the board of text this vocabulary exists to make unaskable. Rejected here
     * rather than repaired, like every other violation: the retry path can ask
     * properly, and silently demoting it to `focus` would hide a scene the
     * script stage deliberately chose to show rather than describe.
     */
    if (shape === 'illustration' && !input.imageBrief?.query.trim()) {
      throw new Error("Shape 'illustration' needs an imageBrief naming what to find.");
    }
    if (shape !== 'illustration' && input.imageBrief) {
      throw new Error(`Shape '${shape}' draws its own board and takes no imageBrief.`);
    }

    const limits = SHAPE_LIMITS[shape];
    const nodes = input.nodes ?? [];
    if (nodes.length < limits.min || nodes.length > limits.max) {
      throw new Error(
        `Shape '${shape}' takes ${limits.min}–${limits.max} nodes; ${nodes.length} were given.`,
      );
    }

    const ids = new Set<string>();
    for (const node of nodes) {
      const id = node.id.trim();
      if (!id) throw new Error('A node has an empty id.');
      if (ids.has(id)) throw new Error(`Duplicate node id '${id}'.`);
      ids.add(id);

      const label = node.label.trim();
      if (!label) throw new Error(`Node '${id}' has an empty label.`);
      const words = label.split(/\s+/).length;
      if (words > limits.labelWords) {
        throw new Error(
          `Node '${id}' label is ${words} words; '${shape}' allows ${limits.labelWords} — put the rest in the narration.`,
        );
      }
      if (node.value !== undefined && !(node.value >= 0 && node.value <= 1)) {
        throw new Error(`Node '${id}' value must be between 0 and 1.`);
      }
    }

    // An edge naming a node that does not exist is the one failure that would
    // reach the renderer as a connector to nowhere, so it is checked here
    // rather than defended against in every template.
    const edges = input.edges ?? [];
    for (const edge of edges) {
      if (!ids.has(edge.from)) throw new Error(`Edge references unknown node '${edge.from}'.`);
      if (!ids.has(edge.to)) throw new Error(`Edge references unknown node '${edge.to}'.`);
      if (edge.from === edge.to) throw new Error(`Edge on '${edge.from}' points at itself.`);
    }

    /**
     * The build steps.
     *
     * A board's node budget is a *layout* limit — how much this shape can hold
     * without crowding — so it does not grow just because the board is narrated
     * over three scenes instead of one. The steps decide when the elements
     * arrive, not how many there are. That is the whole idea: one diagram, laid
     * out once and revealed in the order the explanation needs.
     *
     * Two things follow, and both are checked here rather than left to render
     * as a dead frame:
     *  - a board cannot have more steps than it has elements, because some step
     *    would draw nothing and the video would sit on a still board while the
     *    narration talks about something new;
     *  - every step from 1 to `steps` must be occupied, for the same reason.
     */
    const steps = Math.max(1, Math.trunc(input.steps ?? 1));
    const elements = [...nodes, ...edges];

    for (const element of elements) {
      if (element.step === undefined) continue;
      if (!Number.isInteger(element.step) || element.step < 1 || element.step > steps) {
        throw new Error(
          `Step ${String(element.step)} is outside this board's 1–${steps}; ` +
          'a step indexes the board\'s scenes.',
        );
      }
    }

    /**
     * Only a *built* board has to fill its steps.
     *
     * A single-step board reveals whatever it has all at once, and it is allowed
     * to have nothing: `illustration` has a minimum of zero nodes, because a
     * photograph that needs no callouts is already a complete board. Applying
     * the per-step floor there rejected exactly that case.
     */
    if (steps > 1) {
      if (elements.length < steps) {
        throw new Error(
          `A ${steps}-step board needs at least ${steps} elements to reveal, one per step; ` +
          `this one has ${elements.length}.`,
        );
      }

      const occupied = new Set(elements.map((e) => e.step ?? 1));
      const empty = [];
      for (let step = 1; step <= steps; step += 1) if (!occupied.has(step)) empty.push(step);
      if (empty.length > 0) {
        throw new Error(
          `Step ${empty.join(', ')} of this ${steps}-step board draws nothing. ` +
          'Every step is a scene, and a scene whose step adds nothing to the board is a still frame.',
        );
      }
    }

    /**
     * One focal point *per step*, not per board.
     *
     * On a single-step board these are the same rule. On a built board they are
     * not, and the per-board reading would be wrong: the focus is exactly what
     * moves as the explanation advances, so each step gets to name the element
     * the viewer should be looking at while it is spoken.
     */
    for (let step = 1; step <= steps; step += 1) {
      const emphasised = nodes.filter((n) => n.emphasis && (n.step ?? 1) === step);
      if (emphasised.length > 1) {
        throw new Error(
          steps === 1
            ? 'At most one node may be emphasised.'
            : `Step ${step} emphasises ${emphasised.length} nodes; two focal points is no focal point.`,
        );
      }
    }

    /**
     * On a built board every element carries an explicit step, including the
     * ones in step 1.
     *
     * The seek script finds what to dim with `[data-step]`, so an element that
     * omits the attribute is invisible to it — and step 1 is precisely the set
     * that has to recede first. Leaving the default implicit meant a two-step
     * board dimmed nothing at all: the earlier half stayed at full weight and
     * the focus never moved, which is the entire feature.
     *
     * Left implicit on a single-step board, where there is nothing to dim and
     * the attribute would be noise on every element of every ordinary scene.
     */
    const stepped = steps === 1;

    return new SceneDiagram(
      shape,
      title,
      stepped ? nodes : nodes.map((n) => ({ ...n, step: n.step ?? 1 })),
      stepped ? edges : edges.map((e) => ({ ...e, step: e.step ?? 1 })),
      input.caption?.trim() || undefined,
      input.axes,
      input.imageBrief,
      undefined,
      steps,
    );
  }

  /** Elements arriving at `step`, nodes before edges — the order they draw in. */
  public elementsAtStep(step: number): { nodes: readonly DiagramNode[]; edges: readonly DiagramEdge[] } {
    return {
      nodes: this.nodes.filter((n) => (n.step ?? 1) === step),
      edges: this.edges.filter((e) => (e.step ?? 1) === step),
    };
  }

  /**
   * The same diagram with its picture found.
   *
   * Separate from `of` because the search is I/O and validation is not: the
   * description is checked the moment the model returns it, and the fetch
   * happens once — and can fail — afterwards. A diagram that never gets one
   * renders as an empty plate, which is why the caller treats a failed search as
   * a scene to regenerate rather than a board to ship.
   */
  public withImage(image: SceneImage): SceneDiagram {
    return new SceneDiagram(
      this.shape, this.title, this.nodes, this.edges,
      this.caption, this.axes, this.imageBrief, image, this.steps,
    );
  }

  /** Every anchor phrase in the diagram, in the order elements are drawn. */
  public get anchorPhrases(): readonly string[] {
    return [
      ...this.nodes.map((n) => n.anchor),
      ...this.edges.map((e) => e.anchor),
    ].filter((phrase): phrase is string => Boolean(phrase));
  }
}
