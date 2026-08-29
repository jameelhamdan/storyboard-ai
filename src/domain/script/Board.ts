import { Duration } from '../shared/Duration.js';
import type { Scene } from './Scene.js';
import type { DrawSpeed } from './SceneTimeline.js';
import { SHAPE_LIMITS } from './DiagramShape.js';

/**
 * One drawn board, and the consecutive scenes narrated over it.
 *
 * A board is the unit the renderer, the storyboard model and the judge all work
 * in. It exists because the thing that makes an explainer readable is not the
 * quality of any single frame — it is that the diagram *stays* while the
 * narration walks around it. A board is laid out once and revealed in steps:
 * step 1 arrives during the first scene, step 2 during the second, and each new
 * step takes the focus while everything already drawn recedes but remains.
 *
 * A board of one scene is the old behaviour exactly, so nothing about a video
 * whose scenes all stand alone changes.
 *
 * **Every scene in a board shares one `html`.** That is what a board *is*: the
 * markup is generated once, for the whole build, and the per-scene timelines
 * decide which parts of it have arrived at any moment.
 */
export interface BoardReveal {
  readonly elementId: string;
  /** Board-relative, not scene-relative — see `reveals`. */
  readonly at: Duration;
  readonly draw: DrawSpeed;
  /** Which step this element belongs to, 1-based. */
  readonly step: number;
}

export class Board {
  private constructor(
    /** Ordinal within the video, 0-based. */
    public readonly index: number,
    /** Consecutive, in scene order, at least one. */
    public readonly scenes: readonly Scene[],
    /** The silence between two scenes, which is inside a board rather than between boards. */
    public readonly interSceneGap: Duration,
  ) {}

  public static of(index: number, scenes: readonly Scene[], interSceneGap: Duration): Board {
    if (scenes.length === 0) throw new RangeError(`Board ${index} has no scenes.`);
    return new Board(index, [...scenes].sort((a, b) => a.index - b.index), interSceneGap);
  }

  /**
   * One scene as a board of its own.
   *
   * For the callers that genuinely hold a single scene — the previewer judging
   * one attempt, the shape screenshots, a test building a fixture — and for
   * which a one-step board is the correct and complete answer. The gap is zero
   * because there is no second scene for it to fall between.
   */
  public static forScene(scene: Scene): Board {
    return new Board(0, [scene], Duration.zero());
  }

  /** How many steps the board builds over — one per scene. */
  public get steps(): number {
    return this.scenes.length;
  }

  public get firstScene(): Scene {
    return this.scenes[0]!;
  }

  /** Shared across the board's scenes; undefined until the storyboard runs. */
  public get html(): string | undefined {
    return this.firstScene.html;
  }

  public get visualIntent(): Scene['visualIntent'] {
    return this.firstScene.visualIntent;
  }

  /** The scene indexes this board covers, for logging and verdicts. */
  public get sceneIndexes(): readonly number[] {
    return this.scenes.map((s) => s.index);
  }

  /**
   * Total time on screen: every scene's audio, plus the gaps *between* them.
   *
   * The gap after the board's last scene belongs to the boundary with the next
   * board, not to this one — the same rule the audio mix applies, and the reason
   * they stay in step.
   */
  public get duration(): Duration {
    const audio = Duration.sum(this.scenes.map((s) => s.duration));
    return audio.plus(Duration.fromMs(this.interSceneGap.ms * (this.scenes.length - 1)));
  }

  /** Where a scene starts, relative to the board's own start. */
  public offsetOf(sceneIndex: number): Duration {
    let offset = Duration.zero();
    for (const scene of this.scenes) {
      if (scene.index === sceneIndex) return offset;
      offset = offset.plus(scene.duration).plus(this.interSceneGap);
    }
    throw new RangeError(`Scene ${sceneIndex} is not on board ${this.index}.`);
  }

  /**
   * Every element's reveal, rebased onto the board's own clock.
   *
   * Each scene resolves its own anchors against its own measured word timings,
   * because that is the only narration those phrases appear in. But the page is
   * one document spanning the whole board, so the times it is seeked with are
   * board-relative — hence the offset. Getting this wrong does not fail
   * anything; it draws the right element at the wrong moment, which is exactly
   * the class of bug the re-time exists to prevent.
   */
  public get reveals(): readonly BoardReveal[] {
    const reveals: BoardReveal[] = [];

    this.scenes.forEach((scene, step) => {
      const offset = this.offsetOf(scene.index);
      for (const reveal of scene.timeline.reveals) {
        reveals.push({
          elementId: reveal.elementId,
          at: offset.plus(reveal.at),
          draw: reveal.draw,
          step: step + 1,
        });
      }
    });

    return reveals.sort((a, b) => a.at.ms - b.at.ms);
  }
}

/**
 * Cut a scene list into boards.
 *
 * A scene opens a new board unless it declares that it continues the previous
 * one, and two guards override that declaration:
 *
 *  - **The first scene always opens a board**, having nothing to continue.
 *  - **A continuation must agree with the board it joins about the shape.** The
 *    shape is chosen per scene by the stage that read the whole source, and a
 *    board is one diagram — a scene asking to continue a `flow` as a `matrix` is
 *    asking for a diagram that does not exist. Forcing the break there yields a
 *    board per scene, which is merely the old behaviour, rather than a board
 *    whose markup contradicts half its scenes.
 *  - **A board may not have more steps than its shape has room for.** Every step
 *    must add at least one element, and the shape's node limit is for the whole
 *    board — so `focus` holds one node and therefore exactly one scene, and
 *    `comparison` holds two. Without this a `focus` asked to build over two
 *    scenes produces a diagram `SceneDiagram` rejects, and the board falls back
 *    to the built-in one: four of nine scenes in a stub run, before this existed.
 *
 * Pure and total: any scene list produces a valid grouping, so no caller has to
 * handle a malformed one — and in particular, every board it returns is one that
 * `SceneDiagram.of` will accept.
 */
export function groupIntoBoards(
  scenes: readonly Scene[],
  interSceneGap: Duration,
): readonly Board[] {
  const ordered = [...scenes].sort((a, b) => a.index - b.index);
  const groups: Scene[][] = [];

  for (const scene of ordered) {
    const current = groups.at(-1);
    const shape = current?.[0]?.visualIntent;
    const continues =
      scene.continuesBoard &&
      current !== undefined &&
      shape === scene.visualIntent &&
      // One element per step at minimum, and the shape's ceiling is for the
      // whole board — so the shape's node budget is also its step budget.
      current.length < SHAPE_LIMITS[scene.visualIntent].max;

    if (continues) current.push(scene);
    else groups.push([scene]);
  }

  return groups.map((group, index) => Board.of(index, group, interSceneGap));
}
