import type { StoryboardGeneratorPort, GeneratedStoryboard } from '@application/port/StoryboardGeneratorPort.js';
import type { Scene } from '@domain/script/Scene.js';
import type { Board } from '@domain/script/Board.js';
import type { VisualPlan } from '@domain/media/VisualPlan.js';
import type { GateId } from '@domain/quality/QualityScore.js';
import type { LlmClientPort } from '@application/port/LlmClientPort.js';
import type { TokenUsage } from '@application/port/CostMeterPort.js';
import {
  SceneDiagram, type DiagramNode, type DiagramEdge, type DiagramAxes, type ImageBrief,
} from '@domain/script/SceneDiagram.js';
import type { IllustrationFinderPort } from '@application/port/ImageSourcePort.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';
import { SHAPE_LIMITS, SHAPE_GUIDANCE } from '@domain/script/DiagramShape.js';
import { renderDiagram } from '../render/diagram/renderDiagram.js';
import type { PromptLibrary } from './PromptLibrary.js';
import { StubStoryboardGenerator } from '../stub/StubStoryboardGenerator.js';

/**
 * What the illustrator needs when a board turns out to want a picture.
 *
 * Grouped rather than passed as two more positional arguments: they travel
 * together from the stage to the search, they are both about the *image* rather
 * than the diagram, and a third of them is likely.
 */
interface IllustrationContext {
  readonly sources: readonly ImageSourceId[];
  /** The visual plan's concept for this scene — what a drawn board should say. */
  readonly concept?: string;
}

interface SceneDiagramResponse {
  title: string;
  nodes: DiagramNode[];
  edges?: DiagramEdge[];
  caption?: string;
  axes?: DiagramAxes;
  imageBrief?: ImageBrief;
}

/**
 * What the board contains — never where anything sits.
 *
 * The model used to return a complete `<section>` with its own `<style>` block,
 * which made it responsible for layout. It is bad at that: a real run shipped a
 * board whose centre box covered the label beside it, and every gate passed
 * because nothing measured geometry. Positions are now computed by
 * `renderDiagram`, so the model's job is the part it is good at — deciding what
 * the picture says.
 *
 * The shape is deliberately absent: the script stage already chose it with the
 * whole source in front of it, and letting the illustrator override that was a
 * drift source with no upside.
 */
const sceneDiagramSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'The board\'s heading. Under 60 characters.' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string', description: '1-4 words.' },
          detail: { type: 'string', description: 'Optional second line.' },
          value: { type: 'number', description: 'For proportion only: 0-1, the share of the track.' },
          emphasis: { type: 'boolean', description: 'The one focal point. At most one node per step.' },
          anchor: { type: 'string', description: 'Verbatim phrase from the narration this arrives on.' },
          step: {
            type: 'integer',
            description: 'Which step of the build this arrives in, 1-based. Omit on a single-step board.',
          },
        },
        required: ['id', 'label'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string', description: 'A word or two riding the connector.' },
          anchor: { type: 'string' },
          step: {
            type: 'integer',
            description: 'Which step of the build this arrives in, 1-based. Omit on a single-step board.',
          },
        },
        required: ['from', 'to'],
      },
    },
    caption: { type: 'string' },
    /**
     * Only for `illustration`, and required there.
     *
     * The model writes a *search query*, not a description: it is choosing what
     * to go and find in a library of real photographs and published diagrams,
     * and a sentence returns worse results than three good nouns. `kind` routes
     * the search — the diagram of a process and a photograph of the apparatus
     * live in different libraries entirely.
     */
    imageBrief: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms, not a sentence. 2-6 words.' },
        kind: {
          type: 'string',
          enum: ['photo', 'diagram'],
          description: 'photo for what a thing looks like; diagram for a published scientific figure.',
        },
        alt: { type: 'string', description: 'What the picture should show, in one phrase.' },
      },
      required: ['query', 'kind', 'alt'],
    },
    axes: {
      type: 'object',
      properties: { x: { type: 'string' }, y: { type: 'string' } },
    },
  },
  required: ['title', 'nodes'],
};

/**
 * Volume tier: the output is schema-constrained and schema-validated, so a
 * violation is caught before anything renders rather than shipped. That is what
 * makes the cheaper model safe here — the expensive one is spent on reading the
 * student's material, not on describing our own boards.
 *
 * One call per scene. Consistency between scenes comes from the shared visual
 * plan and from the templates being the same templates, rather than from
 * showing the model its neighbours.
 */
export class PromptedStoryboardGenerator implements StoryboardGeneratorPort {
  /** Produces the last-resort board; no model call needed. */
  private readonly fallbackGenerator = new StubStoryboardGenerator();

  constructor(
    private readonly client: LlmClientPort,
    private readonly prompts: PromptLibrary,
    /**
     * Absent when no image library is configured. The script stage is told the
     * same thing and does not choose `illustration` in that case, so this is a
     * second line of defence rather than the mechanism — but it is the one that
     * decides what actually happens if a model picks the shape anyway.
     */
    private readonly images?: IllustrationFinderPort,
    private readonly logger?: LoggerPort,
  ) {}

  public async generate(input: {
    boards: readonly Board[];
    visualPlan?: VisualPlan;
    direction?: string;
    imageSources?: readonly ImageSourceId[];
    signal?: AbortSignal;
  }): Promise<readonly GeneratedStoryboard[]> {
    /**
     * One call per board, run together.
     *
     * Scenes used to be batched into a single call that had to emit complete
     * markup for all of them at once. That capped how elaborate any one scene
     * could be — the whole batch shared an output budget — and when it ran out
     * the JSON came back short and scenes went missing. A board is not that
     * batch: it is *one diagram*, so it has one description and one output
     * budget that belongs to it, and a board that fails affects only itself.
     *
     * It is also where the saving is. A board narrated over three scenes used to
     * be three calls, each carrying the full shape guidance and design brief;
     * now it is one, and the model gets to see the whole build before deciding
     * what arrives when — which is the only way it could place the steps well.
     */
    return Promise.all(input.boards.map((board) => this.ask(
      board,
      this.briefFor(board, input.visualPlan, input.direction),
      this.illustrationContext(board.firstScene, input.imageSources, input.visualPlan),
      input.signal,
    )));
  }

  public async regenerate(input: {
    board: Board;
    failedGates: readonly GateId[];
    notes: readonly string[];
    visualPlan?: VisualPlan;
    direction?: string;
    imageSources?: readonly ImageSourceId[];
    signal?: AbortSignal;
  }): Promise<GeneratedStoryboard> {
    const brief = [
      this.briefFor(input.board, input.visualPlan, input.direction),
      '',
      'Your previous attempt at this board was rejected.',
      'Fix exactly these problems and change nothing else:',
      ...input.failedGates.map((g) => `- gate ${g} failed`),
      ...input.notes.map((n) => `- ${n}`),
    ].join('\n');

    return this.ask(
      input.board,
      brief,
      this.illustrationContext(input.board.firstScene, input.imageSources, input.visualPlan),
      input.signal,
    );
  }

  /**
   * The scene as the illustrator sees it.
   *
   * The shape's node range is stated explicitly because it is a hard constraint
   * — `SceneDiagram` rejects a diagram outside it, and a rejection the model
   * could have avoided costs a full retry.
   */
  private briefFor(board: Board, visualPlan?: VisualPlan, direction?: string): string {
    const scene = board.firstScene;
    const plan = visualPlan?.forScene(scene.index);
    const shape = board.visualIntent;
    const limits = SHAPE_LIMITS[shape];

    /**
     * The narration, split by step when there is more than one.
     *
     * The model has to see the whole build to place the steps, and it has to see
     * where each step's narration begins and ends to anchor into it — an anchor
     * is a verbatim phrase from *one* scene, and a phrase copied across a step
     * boundary matches nothing.
     */
    const narration = board.steps === 1
      ? [`Narration: ${scene.spokenText}`]
      : [
          `This board is built over ${board.steps} steps, one per scene below.`,
          'Lay out the whole diagram; the step decides when each part arrives.',
          '',
          ...board.scenes.flatMap((s, i) => [`Step ${i + 1} narration: ${s.spokenText}`, '']),
        ];

    return [
      ...narration,
      '',
      `Shape: ${shape} — ${SHAPE_GUIDANCE[shape]}`,
      `Nodes: between ${limits.min} and ${limits.max} for the whole board.`,
      ...(board.steps > 1
        ? [
            `Every step from 1 to ${board.steps} must add at least one node or edge.`,
            'Give each element a step. Anchor it to a phrase from that step\'s narration.',
            'Emphasise at most one node per step — the focus moves as the build advances.',
          ]
        : []),
      ...(shape === 'illustration'
        ? [
            'You are not drawing this board — you are choosing what to find and what to label on it.',
            'Give an imageBrief. Its query is search terms for a real image library, not a sentence.',
            'Nodes are callouts pointing into the picture; give none rather than inventing one.',
          ]
        : []),
      ...(plan ? [`Design intent: ${plan.concept}`] : []),
      ...(plan?.emphasis.length ? [`Emphasise: ${plan.emphasis.join(', ')}`] : []),
      // Last, so it reads as a preference over the constraints above rather than
      // as a licence to break them.
      ...(direction ? [`The person who requested this video asked for: ${direction}`] : []),
    ].join('\n');
  }

  private illustrationContext(
    scene: Scene,
    sources: readonly ImageSourceId[] | undefined,
    visualPlan: VisualPlan | undefined,
  ): IllustrationContext {
    const concept = visualPlan?.forScene(scene.index)?.concept;
    return { sources: sources ?? [], ...(concept ? { concept } : {}) };
  }

  private async ask(
    board: Board,
    brief: string,
    illustration: IllustrationContext,
    signal?: AbortSignal,
  ): Promise<GeneratedStoryboard> {
    const prompt = this.prompts.render('02-scene-diagram', { scene: brief });

    const result = await this.client.generate<SceneDiagramResponse>({
      system: prompt.system,
      user: prompt.user,
      tier: 'volume',
      responseSchema: sceneDiagramSchema as unknown as Record<string, unknown>,
      maxOutputTokens: storyboardOutputCeiling(board),
      ...(signal ? { signal } : {}),
    });

    return this.build(board, result.parsed, result.usage, illustration, signal);
  }

  /**
   * A description that does not validate is treated as no answer at all.
   *
   * Repairing it here would be guessing at what the model meant, and the retry
   * path already exists to ask it properly — this only has to make the failure
   * a fallback rather than a crash.
   */
  private async build(
    board: Board,
    parsed: SceneDiagramResponse | undefined,
    usage: TokenUsage,
    illustration: IllustrationContext,
    signal?: AbortSignal,
  ): Promise<GeneratedStoryboard> {
    const scene = board.firstScene;
    if (!parsed) {
      return { ...this.fallbackGenerator.fallback(scene), usage, usedFallback: true };
    }

    let diagram: SceneDiagram;
    try {
      diagram = SceneDiagram.of({
        shape: board.visualIntent,
        steps: board.steps,
        title: parsed.title,
        nodes: parsed.nodes ?? [],
        ...(parsed.edges ? { edges: parsed.edges } : {}),
        ...(parsed.caption ? { caption: parsed.caption } : {}),
        ...(parsed.axes ? { axes: parsed.axes } : {}),
        ...(parsed.imageBrief ? { imageBrief: parsed.imageBrief } : {}),
      });
    } catch {
      return { ...this.fallbackGenerator.fallback(scene), usage, usedFallback: true };
    }

    /**
     * The search happens here, after validation and before rendering, because
     * an `illustration` plate with no picture is an empty plate — the credit
     * line under a hole. A miss is therefore a fallback board, exactly like a
     * description that failed to validate: something renderable ships, and the
     * substitution is *recorded* rather than silently looking like a plain
     * scene somebody chose.
     */
    if (diagram.imageBrief) {
      const image = this.images
        ? await this.images.find({
            query: diagram.imageBrief.query,
            kind: diagram.imageBrief.kind,
            // What the scene is *for*, which only a source that draws can use.
            ...(illustration.concept ? { styleNote: illustration.concept } : {}),
            // The job's own list. Empty would mean "ask nothing", which is why
            // the stage only reaches here when the job allows at least one.
            sources: illustration.sources,
            ...(signal ? { signal } : {}),
          }).catch(() => undefined)
        : undefined;

      if (!image) {
        this.logger?.warn(
          { sceneIndex: scene.index, query: diagram.imageBrief.query, kind: diagram.imageBrief.kind },
          'no image found for an illustration scene; falling back to the built-in board',
        );
        return { ...this.fallbackGenerator.fallback(scene), usage, usedFallback: true };
      }
      diagram = diagram.withImage(image);
    }

    const rendered = renderDiagram(diagram, scene.index);
    return {
      sceneIndex: scene.index,
      sceneIndexes: board.sceneIndexes,
      html: rendered.html,
      anchors: rendered.anchors,
      usage,
    };
  }

  public fallback(scene: Scene): GeneratedStoryboard {
    return this.fallbackGenerator.fallback(scene);
  }
}

/**
 * How much output one board's description may take.
 *
 * A diagram description is small — a title, a handful of nodes with short
 * labels, some edges — and it was previously left to the client's 8192-token
 * default, which is between ten and thirty times what any board has ever
 * needed. An unbounded ceiling does not save money when the model is terse, but
 * it removes the only guard against a model that starts explaining itself in
 * prose, and it is the difference between a bad board and a bad board that cost
 * a dollar.
 *
 * Scaled by steps because a built board genuinely describes more: the same node
 * budget, but each element additionally carries a step and an anchor phrase from
 * its own scene's narration.
 */
function storyboardOutputCeiling(board: Board): number {
  return 700 + 500 * board.steps;
}
