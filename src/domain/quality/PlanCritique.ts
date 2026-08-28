/**
 * What a plan review can object to.
 *
 * A closed vocabulary rather than free text, because the categories are what
 * make a critique *actionable*: `shape` sends the revision at one scene's
 * `visualIntent`, `coverage` sends it at the scene list, and `pacing` sends it
 * at the word budget. A judge that only writes prose produces a rewrite that
 * changes everything and fixes nothing — which is exactly what the scene judge
 * learned when it was given gate ids instead of a single shared note.
 */
export const PLAN_ISSUES = [
  'coverage',    // the material has something important the plan never reaches
  'ordering',    // a scene depends on something explained after it
  'redundancy',  // two scenes say the same thing
  'scope',       // one scene carries more than one idea
  'shape',       // the visualIntent does not fit what the scene actually says
  'pacing',      // the scene count or length does not fit the target duration
  'opening',     // the video does not establish what it is about
] as const;

export type PlanIssueKind = (typeof PLAN_ISSUES)[number];

export interface PlanIssue {
  readonly kind: PlanIssueKind;
  /** Which scene, when the issue is about one. Absent for whole-plan issues. */
  readonly sceneIndex?: number;
  /** The judge's own words. This is what a revision is actually given. */
  readonly note: string;
}

/**
 * A verdict on the whole story before a single board is drawn.
 *
 * The scene judge grades a rendered board and can only ever fix that board. By
 * then the *story* is settled: which ideas got a scene, in what order, and
 * whether scene four needed something scene six explains. Nothing downstream
 * can repair that — a beautifully drawn board of the wrong idea passes every
 * gate — so it is graded here, where a revision costs one text call rather than
 * a re-illustrated, re-judged, re-rendered video.
 *
 * `approved` is the judge's own answer rather than a threshold on `score`. The
 * score drifts between runs and is reported, never gated on — the same rule the
 * scene judge follows, for the same reason.
 */
export class PlanCritique {
  private constructor(
    public readonly approved: boolean,
    public readonly issues: readonly PlanIssue[],
    /** 1-5, reported and never gated on. */
    public readonly score: number | undefined,
    public readonly summary: string,
  ) {}

  public static of(input: {
    approved: boolean;
    issues: readonly PlanIssue[];
    score?: number;
    summary?: string;
  }): PlanCritique {
    const issues = input.issues.filter((issue) => issue.note.trim().length > 0);

    /**
     * An approval carrying objections is a contradiction, and the safe reading
     * is the pessimistic one: a model that lists three problems and ticks the
     * box has told us about three problems. Taking the tick at face value is how
     * a review becomes a formality that always passes.
     */
    const approved = input.approved && issues.length === 0;

    return new PlanCritique(
      approved,
      issues,
      input.score !== undefined && Number.isFinite(input.score)
        ? Math.min(5, Math.max(1, Math.round(input.score * 10) / 10))
        : undefined,
      (input.summary ?? '').trim(),
    );
  }

  /** The lines a revision is given, one per objection. */
  public get notes(): readonly string[] {
    return this.issues.map((issue) => (
      issue.sceneIndex === undefined
        ? `${issue.kind}: ${issue.note}`
        : `${issue.kind} (scene ${issue.sceneIndex}): ${issue.note}`
    ));
  }

  public get kinds(): readonly PlanIssueKind[] {
    return [...new Set(this.issues.map((issue) => issue.kind))];
  }
}
