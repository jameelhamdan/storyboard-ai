import { GATES, type GateId, type GateResult, HolisticScore } from './QualityScore.js';

export interface SceneVerdict {
  readonly sceneIndex: number;
  readonly gates: readonly GateResult[];
  readonly holistic: HolisticScore | undefined;
  readonly attempt: number;
}

/**
 * Per-dimension results plus the reported score. Returned on the status payload so
 * StudyCore can gate app-side on numbers it can see, which is what replaces the
 * brief's unmeasurable "assessed by Saman".
 */
export class QualityVerdict {
  private constructor(
    public readonly scenes: readonly SceneVerdict[],
    public readonly scenesRegenerated: number,
    public readonly scenesFallback: number,
    /**
     * Scenes rendered with the built-in last-resort board rather than the model's.
     *
     * Distinct from `scenesFallback`, which counts only scenes the *judge*
     * rejected. A scene the model never produced is swapped out at storyboard
     * time and the judge never sees it, so a video of mostly stub scenes could
     * report zero fallbacks and pass every gate.
     */
    public readonly scenesBuiltInLayout: number,
    public readonly deterministicFailures: readonly string[],
  ) {}

  public static of(input: {
    scenes: readonly SceneVerdict[];
    scenesRegenerated: number;
    scenesFallback: number;
    scenesBuiltInLayout?: number;
    deterministicFailures?: readonly string[];
  }): QualityVerdict {
    return new QualityVerdict(
      input.scenes, input.scenesRegenerated, input.scenesFallback,
      input.scenesBuiltInLayout ?? 0,
      input.deterministicFailures ?? [],
    );
  }

  public static empty(): QualityVerdict {
    return new QualityVerdict([], 0, 0, 0, []);
  }

  public get holisticMean(): HolisticScore | undefined {
    return HolisticScore.mean(
      this.scenes.map((s) => s.holistic).filter((s): s is HolisticScore => s !== undefined),
    );
  }

  /** Per-gate failure counts — the row the §13 results table reports. */
  public get failuresByGate(): Readonly<Record<GateId, number>> {
    const counts = Object.fromEntries(GATES.map((g) => [g, 0])) as Record<GateId, number>;
    for (const scene of this.scenes) {
      for (const gate of scene.gates) {
        if (!gate.passed) counts[gate.gate] += 1;
      }
    }
    return counts;
  }

  public toJSON(): Record<string, unknown> {
    return {
      scenes_total: this.scenes.length,
      scenes_regenerated: this.scenesRegenerated,
      scenes_fallback: this.scenesFallback,
      scenes_built_in_layout: this.scenesBuiltInLayout,
      holistic_score_mean: this.holisticMean?.value ?? null,
      gate_failures: this.failuresByGate,
    };
  }
}
