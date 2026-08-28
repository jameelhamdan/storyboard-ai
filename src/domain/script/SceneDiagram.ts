import { SHAPE_LIMITS, toDiagramShape, type DiagramShape } from './DiagramShape.js';
import type { SceneImage } from '@domain/media/SceneImage.js';

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
export interface DiagramNode {
  readonly id: string;
  /** Short — the shape decides how short. Longer belongs in the narration. */
  readonly label: string;
  /** An optional second line, for a shape whose template has room for one. */
  readonly detail?: string;
  /** 0–1, for `proportion` only: the share of the track this bar fills. */
  readonly value?: number;
  /** Draws this node in the accent colour. At most one per diagram. */
  readonly emphasis?: boolean;
  /** Verbatim phrase from the spoken narration that this node arrives on. */
  readonly anchor?: string;
}

export interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  /** A word or two riding the connector — `charging`, `+`, `then`. */
  readonly label?: string;
  readonly anchor?: string;
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

    if (nodes.filter((n) => n.emphasis).length > 1) {
      // Two focal points is no focal point; the composition rule the prompt
      // states is worth enforcing rather than repeating.
      throw new Error('At most one node may be emphasised.');
    }

    return new SceneDiagram(
      shape,
      title,
      nodes,
      edges,
      input.caption?.trim() || undefined,
      input.axes,
      input.imageBrief,
      undefined,
    );
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
      this.caption, this.axes, this.imageBrief, image,
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
