import { Duration } from '../shared/Duration.js';
import type { Scene } from './Scene.js';
import type { QualityPreset } from '../media/QualityPreset.js';
import { groupIntoBoards, type Board } from './Board.js';

export interface SceneWindow {
  readonly sceneIndex: number;
  readonly start: Duration;
  readonly end: Duration;
  readonly startFrame: number;
  readonly endFrame: number;
}

/**
 * A board's span on the video's clock.
 *
 * Distinct from a scene window because the board is what the *renderer* works
 * in: one document, loaded once, seeked across the whole span. The scene
 * windows inside it still exist — they are what decides the current step — but
 * nothing is redrawn from scratch at a scene boundary within a board, and no
 * cross-fade happens there either. A wipe means "new diagram", so it belongs at
 * board boundaries and nowhere else.
 */
export interface BoardWindow {
  readonly boardIndex: number;
  readonly start: Duration;
  readonly end: Duration;
  readonly startFrame: number;
  readonly endFrame: number;
}

/**
 * Scenes plus the global timeline. `retime()` is the actual narration/visual sync
 * mechanism and the reason rendering happens after synthesis rather than beside it:
 * planned scene durations never match synthesized audio, so the whole timeline is
 * rebuilt from measured audio before a single frame is drawn.
 */
export class Storyboard {
  private constructor(
    public readonly scenes: readonly Scene[],
    public readonly windows: readonly SceneWindow[],
    public readonly preset: QualityPreset,
    public readonly interSceneGap: Duration,
    public readonly boards: readonly Board[],
    public readonly boardWindows: readonly BoardWindow[],
  ) {}

  public static of(scenes: readonly Scene[], preset: QualityPreset, interSceneGap: Duration): Storyboard {
    return new Storyboard(scenes, [], preset, interSceneGap, [], []).retime();
  }

  /**
   * Rebuild every window from the scenes' current durations.
   *
   * Boards are regrouped here rather than carried, because the grouping is a
   * pure function of the scenes and carrying it would let the two disagree after
   * a scene is replaced — which is exactly what happens when the judge ships a
   * fallback board and the continuation it was part of has to break.
   */
  public retime(): Storyboard {
    const windows: SceneWindow[] = [];
    let cursor = Duration.zero();

    for (const scene of this.scenes) {
      const start = cursor;
      const end = start.plus(scene.duration);
      windows.push({
        sceneIndex: scene.index,
        start,
        end,
        startFrame: start.toFrames(this.preset.fps),
        endFrame: end.toFrames(this.preset.fps),
      });
      cursor = end.plus(this.interSceneGap);
    }

    const boards = groupIntoBoards(this.scenes, this.interSceneGap);
    const byScene = new Map(windows.map((w) => [w.sceneIndex, w]));

    // A board spans from its first scene's start to its last scene's end, so it
    // is built from the scene windows rather than by walking the clock twice.
    const boardWindows: BoardWindow[] = boards.map((board) => {
      const first = byScene.get(board.firstScene.index)!;
      const last = byScene.get(board.scenes.at(-1)!.index)!;
      return {
        boardIndex: board.index,
        start: first.start,
        end: last.end,
        startFrame: first.startFrame,
        endFrame: last.endFrame,
      };
    });

    return new Storyboard(this.scenes, windows, this.preset, this.interSceneGap, boards, boardWindows);
  }

  public withScenes(scenes: readonly Scene[]): Storyboard {
    return new Storyboard(
      scenes, this.windows, this.preset, this.interSceneGap, this.boards, this.boardWindows,
    ).retime();
  }

  public get totalDuration(): Duration {
    const last = this.windows.at(-1);
    return last ? last.end : Duration.zero();
  }

  public get totalFrames(): number {
    return this.totalDuration.toFrames(this.preset.fps);
  }

  public windowFor(sceneIndex: number): SceneWindow | undefined {
    return this.windows.find((w) => w.sceneIndex === sceneIndex);
  }
}
