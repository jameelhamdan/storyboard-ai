import { Duration } from '../shared/Duration.js';
import type { Language } from '../shared/Language.js';
import type { Scene } from './Scene.js';

/** The resolved personalisation decision, recorded so FR-14 is testable. */
export interface NarrationBrief {
  readonly register: string;
  readonly assumedPriorKnowledge: string;
  readonly structure: string;
  readonly emphasisedTopics: readonly string[];
  readonly explicitInstructions: string | undefined;
  /** The chosen style's narration sentence — see config/styles.yaml. */
  readonly styleNote: string;
  /** The caller's free-text steer for this one video. Untrusted; see ExtraDirection. */
  readonly extraDirection: string | undefined;
}

export class NarrationScript {
  private constructor(
    public readonly scenes: readonly Scene[],
    public readonly language: Language,
    public readonly brief: NarrationBrief,
  ) {}

  public static of(scenes: readonly Scene[], language: Language, brief: NarrationBrief): NarrationScript {
    if (scenes.length === 0) throw new RangeError('A narration script needs at least one scene.');
    return new NarrationScript([...scenes].sort((a, b) => a.index - b.index), language, brief);
  }

  public get totalDuration(): Duration {
    return Duration.sum(this.scenes.map((s) => s.duration));
  }

  public get wordCount(): number {
    return this.scenes.reduce((t, s) => t + s.wordCount, 0);
  }

  public withScenes(scenes: readonly Scene[]): NarrationScript {
    return NarrationScript.of(scenes, this.language, this.brief);
  }

  public replaceScene(updated: Scene): NarrationScript {
    return this.withScenes(this.scenes.map((s) => (s.index === updated.index ? updated : s)));
  }
}
