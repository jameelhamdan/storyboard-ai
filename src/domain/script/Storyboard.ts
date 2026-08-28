import { Duration } from '../shared/Duration.js';
import type { Scene } from './Scene.js';
import type { QualityPreset } from '../media/QualityPreset.js';

export interface SceneWindow {
  readonly sceneIndex: number;
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
  ) {}

  public static of(scenes: readonly Scene[], preset: QualityPreset, interSceneGap: Duration): Storyboard {
    return new Storyboard(scenes, [], preset, interSceneGap).retime();
  }

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

    return new Storyboard(this.scenes, windows, this.preset, this.interSceneGap);
  }

  public withScenes(scenes: readonly Scene[]): Storyboard {
    return new Storyboard(scenes, this.windows, this.preset, this.interSceneGap).retime();
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
