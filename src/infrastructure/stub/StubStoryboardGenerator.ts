import type { StoryboardGeneratorPort, GeneratedStoryboard } from '@application/port/StoryboardGeneratorPort.js';
import type { Scene } from '@domain/script/Scene.js';
import { Board } from '@domain/script/Board.js';
import { SceneDiagram, type DiagramNode, type DiagramEdge } from '@domain/script/SceneDiagram.js';
import { SHAPE_LIMITS, type DiagramShape } from '@domain/script/DiagramShape.js';
import { renderDiagram } from '../render/diagram/renderDiagram.js';

/**
 * Builds a real diagram description from the scene's own narration, so a stub
 * run exercises validation, the renderer, anchor resolution and the reveal path
 * for real. Only the *wording* is stubbed; everything downstream sees
 * production-shaped input.
 *
 * **Labels are clauses, not word windows.** The previous implementation sliced
 * the narration into three-word windows at a fixed stride and truncated each to
 * four words, producing labels like "cathode is lithium" and "to lodge in".
 * That was tolerable in a stub and intolerable in the thing it was also being
 * used for — the production fallback — which is how two of five scenes in
 * `out/20260827-202226-battery` shipped as fragments. Clauses at least read as
 * language.
 */
export class StubStoryboardGenerator implements StoryboardGeneratorPort {
  public async generate(input: { boards: readonly Board[] }): Promise<readonly GeneratedStoryboard[]> {
    return input.boards.map((board) => this.build(board));
  }

  public async regenerate(input: { board: Board }): Promise<GeneratedStoryboard> {
    return this.build(input.board);
  }

  /**
   * The last-resort board, used when no attempt produced anything renderable.
   *
   * It is a `focus`: the scene's opening sentence stated large with a drawn mark
   * under it. That is a legitimate diagram and it is the only honest one
   * available here — without a model there is nothing to decide which parts of
   * the narration are the nodes, and inventing some is what produced the
   * fragments this replaced.
   */
  public fallback(scene: Scene): GeneratedStoryboard {
    const sentence = firstSentence(scene.writtenText);
    return this.render(
      Board.forScene(scene),
      SceneDiagram.of({
        shape: 'focus',
        title: titleFor(scene),
        nodes: [{ id: 'idea', label: clampWords(sentence, SHAPE_LIMITS.focus.labelWords) }],
      }),
      true,
    );
  }

  private build(board: Board): GeneratedStoryboard {
    const scene = board.firstScene;

    /**
     * `illustration` becomes `focus` here, and there is no stub version of it.
     *
     * Every other shape is drawable from the narration alone, which is what
     * makes this generator honest — the stub exercises the real renderer with
     * real validation. An illustration is not: its board *is* a found
     * photograph, and there is no library behind this class. Inventing a
     * placeholder image would make a stub run look like a working feature, and
     * an empty plate would render as a credit line under a hole.
     */
    const shape = board.visualIntent === 'illustration' ? 'focus' : board.visualIntent;
    const limits = SHAPE_LIMITS[shape];

    /**
     * A node budget the board can actually satisfy.
     *
     * Two floors meet here: the shape's own minimum, and one node per step,
     * because a step that adds nothing to the board is rejected. The shape's
     * maximum caps both — which is also why the script stage may not open a
     * board with more steps than its shape has room for.
     */
    const steps = Math.min(board.steps, limits.max);
    const wanted = Math.min(Math.max(limits.min, steps, 3), limits.max);

    /**
     * Nodes drawn from each step's *own* narration.
     *
     * An anchor has to be a verbatim substring of the scene that speaks it, so a
     * node belonging to step 2 takes its phrase from scene 2. Taking them all
     * from the first scene would produce a board whose later steps never resolve
     * and silently inherit the previous element's time.
     */
    const nodes: DiagramNode[] = [];
    for (let i = 0; i < wanted; i += 1) {
      const step = steps === 0 ? 1 : (i % steps) + 1;
      const source = board.scenes[Math.min(step - 1, board.scenes.length - 1)]!;
      const phrases = clausesOf(source.spokenText);
      const phrase = phrases[Math.floor(i / Math.max(steps, 1))] ?? phrases[0] ?? source.spokenText;

      nodes.push({
        id: `n${i}`,
        label: clampWords(phrase, limits.labelWords),
        anchor: phrase,
        ...(board.steps > 1 ? { step } : {}),
        ...(shape === 'proportion' ? { value: 1 - i * 0.25 } : {}),
      });
    }

    // Sorted by step so the ids run in the order the board builds, which is what
    // the templates lay out along their axis.
    nodes.sort((a, b) => (a.step ?? 1) - (b.step ?? 1));

    /**
     * A description that will not validate becomes the fallback board, never an
     * exception.
     *
     * `groupIntoBoards` already guarantees a board its shape can express, so
     * reaching this means something upstream changed — and this class is also
     * the *production* fallback, where a throw would take down a job that was
     * being rescued. The prompted generator has always treated invalid output
     * this way; the stub used to throw, which made it the more fragile of the
     * two on exactly the path that exists to be safe.
     */
    try {
      return this.render(board, SceneDiagram.of({
        shape,
        title: titleFor(scene),
        nodes,
        edges: edgesFor(shape, nodes),
        ...(board.steps > 1 ? { steps: board.steps } : {}),
        ...(shape === 'matrix' ? { axes: { x: 'more', y: 'less' } } : {}),
      }), false);
    } catch {
      return this.fallback(scene);
    }
  }

  /**
   * A board's result names *every* scene it covers.
   *
   * They share one document, and the storyboard stage keys its results by scene
   * — so a board that reported only its first scene left the rest looking like
   * scenes the generator never answered for, and each was quietly replaced by
   * the built-in board. Four of nine scenes in a stub run, and the video still
   * rendered, which is exactly how it went unnoticed.
   */
  private render(board: Board, diagram: SceneDiagram, usedFallback: boolean): GeneratedStoryboard {
    const scene = board.firstScene;
    const rendered = renderDiagram(diagram, scene.index);
    return {
      sceneIndex: scene.index,
      sceneIndexes: board.sceneIndexes,
      html: rendered.html,
      anchors: rendered.anchors,
      usage: { inputTokens: 0, outputTokens: 0, model: 'stub' },
      ...(usedFallback ? { usedFallback: true } : {}),
    };
  }
}

/** Only the shapes whose templates draw connectors need edges. */
function edgesFor(shape: DiagramShape, nodes: readonly DiagramNode[]): DiagramEdge[] {
  if (!['flow', 'cycle', 'equation'].includes(shape)) return [];
  // An edge arrives with the node it points at: the connector into a box is part
  // of that box's step, not of the step that drew the box it comes from.
  return nodes.slice(1).map((node, i) => ({
    from: nodes[i]!.id,
    to: node.id,
    ...(node.step !== undefined ? { step: node.step } : {}),
  }));
}

/**
 * The narration split at clause boundaries, which is where a phrase that reads
 * as language begins and ends.
 */
function clausesOf(text: string): string[] {
  return text
    .split(/[,;.]|\s+(?:and|but|while|because|so)\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.split(/\s+/).length >= 2);
}

/** The scene's opening sentence, whole — never cut mid-clause. */
function firstSentence(text: string): string {
  return text.split(/(?<=[.!?])\s/)[0]?.trim() ?? text.trim();
}

/**
 * A title that ends where a clause ends.
 *
 * A blind word slice is what produced "The negative anode is graphite and" — a
 * heading cut mid-conjunction. Trimming to a clause boundary costs nothing and
 * cannot produce a fragment.
 */
function titleFor(scene: Scene): string {
  const clause = clausesOf(scene.writtenText)[0] ?? firstSentence(scene.writtenText);
  return clampChars(clause, 60) || 'Overview';
}

function clampWords(text: string, max: number): string {
  const words = text.replace(/[^\p{L}\p{N}\s%.-]/gu, '').split(/\s+/).filter(Boolean);
  return words.slice(0, max).join(' ') || 'Overview';
}

function clampChars(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  // Back off to the last whole word rather than cutting a word in half.
  return clean.slice(0, clean.lastIndexOf(' ', max) > 0 ? clean.lastIndexOf(' ', max) : max).trim();
}
