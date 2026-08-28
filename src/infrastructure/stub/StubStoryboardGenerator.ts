import type { StoryboardGeneratorPort, GeneratedStoryboard } from '@application/port/StoryboardGeneratorPort.js';
import type { Scene } from '@domain/script/Scene.js';
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
  public async generate(input: { scenes: readonly Scene[] }): Promise<readonly GeneratedStoryboard[]> {
    return input.scenes.map((scene) => this.build(scene));
  }

  public async regenerate(input: { scene: Scene }): Promise<GeneratedStoryboard> {
    return this.build(input.scene);
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
      scene,
      SceneDiagram.of({
        shape: 'focus',
        title: titleFor(scene),
        nodes: [{ id: 'idea', label: clampWords(sentence, SHAPE_LIMITS.focus.labelWords) }],
      }),
      true,
    );
  }

  private build(scene: Scene): GeneratedStoryboard {
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
    const shape = scene.visualIntent === 'illustration' ? 'focus' : scene.visualIntent;
    const limits = SHAPE_LIMITS[shape];
    const phrases = clausesOf(scene.spokenText);

    // Meet the shape's minimum; never exceed its maximum. Both are hard — the
    // diagram is rejected outside the range, and a stub that cannot satisfy its
    // own domain rules is worse than useless.
    const wanted = Math.min(Math.max(limits.min, Math.min(phrases.length, 3)), limits.max);
    const chosen = phrases.slice(0, wanted);
    while (chosen.length < limits.min) chosen.push(chosen[chosen.length - 1] ?? scene.spokenText);

    const nodes: DiagramNode[] = chosen.map((phrase, i) => ({
      id: `n${i}`,
      label: clampWords(phrase, limits.labelWords),
      // Anchors must be verbatim substrings of the spoken text, so they are the
      // clause itself rather than the shortened label.
      anchor: phrase,
      ...(shape === 'proportion' ? { value: 1 - i * 0.25 } : {}),
    }));

    return this.render(scene, SceneDiagram.of({
      shape,
      title: titleFor(scene),
      nodes,
      edges: edgesFor(shape, nodes),
      ...(shape === 'matrix' ? { axes: { x: 'more', y: 'less' } } : {}),
    }), false);
  }

  private render(scene: Scene, diagram: SceneDiagram, usedFallback: boolean): GeneratedStoryboard {
    const rendered = renderDiagram(diagram, scene.index);
    return {
      sceneIndex: scene.index,
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
  return nodes.slice(1).map((node, i) => ({ from: nodes[i]!.id, to: node.id }));
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
