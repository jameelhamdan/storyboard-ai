import { JobId } from './JobId.js';
import { canTransition, isTerminal, type JobStatus } from './JobStatus.js';
import { Progress } from './Progress.js';
import type { JobFeatures, JobFeatureFlags } from './JobFeatures.js';
import { Language } from '../shared/Language.js';
import { Duration } from '../shared/Duration.js';
import { StudentContext } from '../shared/StudentContext.js';
import type { GenerationCost } from '../cost/GenerationCost.js';
import type { QualityVerdict } from '../quality/QualityVerdict.js';
import type { QuizQuestion } from '../quiz/QuizQuestion.js';
import type { QualityPreset } from '../media/QualityPreset.js';
import type { VideoStyle, ExtraDirection } from '../media/VideoStyle.js';
import type { DomainErrorCode } from '../error/DomainError.js';

export interface JobArtifacts {
  readonly videoUrl: string;
  readonly subtitleUrl: string;
  readonly traceabilityUrl: string;
  /** Token usage and estimated spend per provider. */
  readonly costUrl: string;
  readonly durationSeconds: number;
}

export interface JobFailure {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface VideoJobSnapshot {
  readonly id: string;
  readonly status: JobStatus;
  readonly progressPercent: number;
  readonly stage: string | null;
  readonly outputLanguage: string;
  readonly voiceSlot: string;
  readonly qualityPreset: string;
  readonly style: string;
  readonly direction: string | null;
  /** Which optional halves of the pipeline this job asked for. */
  readonly features: JobFeatureFlags;
  readonly targetDurationSeconds: number | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** Wall-clock seconds from first start to publish; null until completed. */
  readonly generationSeconds: number | null;
  readonly failedAt: string | null;
  readonly cancelledAt: string | null;
  readonly artifacts: JobArtifacts | null;
  readonly failure: JobFailure | null;
  readonly idempotencyKey: string | null;
  readonly requestFingerprint: string | null;
  /**
   * Cost and quality as their API JSON shape. These are read-only reporting data
   * once the job is terminal, and the status payload needs them verbatim — so they
   * round-trip as rendered JSON rather than being rebuilt from a ledger that has
   * no other consumer.
   */
  readonly cost: Record<string, unknown> | null;
  readonly quality: Record<string, unknown> | null;
  readonly quiz: readonly { question: string; answer: string; source_moment_seconds: number }[];
}

/**
 * Aggregate root. Owns identity, the status transitions, progress, artifacts and
 * the terminal outcome. Illegal transitions throw rather than being ignored — a
 * silent no-op here would make the chaos test pass while the job is actually lost.
 */
/**
 * Everything about a job that changes. Grouped rather than passed positionally:
 * the constructor took twenty-four arguments, so `create()` ended in a run of
 * eleven bare `null`s and a wrong-order mistake would have been silent.
 */
interface VideoJobState {
  status: JobStatus;
  progress: Progress;
  stage: string | null;
  updatedAt: Date;
  /** First time a worker picked the job up — not reset by a resume. */
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  cancelledAt: Date | null;
  artifacts: JobArtifacts | null;
  failure: JobFailure | null;
  cost: GenerationCost | null;
  verdict: QualityVerdict | null;
  quiz: readonly QuizQuestion[];
  attempts: number;
  /**
   * Cost and quality as rendered JSON. A job read back from the repository has
   * no live GenerationCost or QualityVerdict — those exist only while it is
   * being processed — but /status must still report both, so the rendered form
   * is what survives persistence.
   */
  costJson: Record<string, unknown> | null;
  qualityJson: Record<string, unknown> | null;
}

/** The immutable half: set once at creation and never touched again. */
interface VideoJobIdentity {
  readonly id: JobId;
  readonly outputLanguage: Language;
  readonly voiceSlot: string;
  readonly qualityPreset: QualityPreset;
  /** How the video reads and looks — see config/styles.yaml. */
  readonly style: VideoStyle;
  /** The caller's free-text steer for this one video. */
  readonly direction: ExtraDirection | undefined;
  readonly features: JobFeatures;
  readonly studentContext: StudentContext;
  readonly targetDuration: Duration | undefined;
  readonly createdAt: Date;
  readonly idempotencyKey: string | undefined;
  readonly requestFingerprint: string | undefined;
}

/**
 * Aggregate root. Owns identity, the status transitions, progress, artifacts and
 * the terminal outcome. Illegal transitions throw rather than being ignored — a
 * silent no-op here would make the chaos test pass while the job is actually lost.
 */
export class VideoJob {
  private constructor(
    private readonly identity: VideoJobIdentity,
    private readonly state: VideoJobState,
  ) {}

  public get id(): JobId { return this.identity.id; }
  public get outputLanguage(): Language { return this.identity.outputLanguage; }
  public get voiceSlot(): string { return this.identity.voiceSlot; }
  public get qualityPreset(): QualityPreset { return this.identity.qualityPreset; }
  public get style(): VideoStyle { return this.identity.style; }
  public get direction(): ExtraDirection | undefined { return this.identity.direction; }
  public get features(): JobFeatures { return this.identity.features; }
  public get studentContext(): StudentContext { return this.identity.studentContext; }
  public get targetDuration(): Duration | undefined { return this.identity.targetDuration; }
  public get createdAt(): Date { return this.identity.createdAt; }
  public get idempotencyKey(): string | undefined { return this.identity.idempotencyKey; }
  public get requestFingerprint(): string | undefined { return this.identity.requestFingerprint; }

  public static create(input: {
    outputLanguage: Language;
    voiceSlot: string;
    qualityPreset: QualityPreset;
    style: VideoStyle;
    direction?: ExtraDirection;
    features: JobFeatures;
    studentContext?: StudentContext;
    targetDuration?: Duration;
    idempotencyKey?: string;
    requestFingerprint?: string;
    now: Date;
  }): VideoJob {
    return new VideoJob(
      {
        id: JobId.generate(),
        outputLanguage: input.outputLanguage,
        voiceSlot: input.voiceSlot,
        qualityPreset: input.qualityPreset,
        style: input.style,
        direction: input.direction,
        features: input.features,
        studentContext: input.studentContext ?? StudentContext.empty(),
        targetDuration: input.targetDuration,
        createdAt: input.now,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
      },
      freshState(input.now),
    );
  }

  public get status(): JobStatus { return this.state.status; }
  public get progress(): Progress { return this.state.progress; }
  public get stage(): string | null { return this.state.stage; }
  public get updatedAt(): Date { return this.state.updatedAt; }
  public get completedAt(): Date | null { return this.state.completedAt; }
  public get failedAt(): Date | null { return this.state.failedAt; }
  public get cancelledAt(): Date | null { return this.state.cancelledAt; }
  public get artifacts(): JobArtifacts | null { return this.state.artifacts; }
  public get failure(): JobFailure | null { return this.state.failure; }
  public get cost(): GenerationCost | null { return this.state.cost; }
  public get verdict(): QualityVerdict | null { return this.state.verdict; }
  public get quiz(): readonly QuizQuestion[] { return this.state.quiz; }
  public get attempts(): number { return this.state.attempts; }

  /**
   * Wall-clock time from the first worker picking the job up to the video being
   * published — what "how long did this take" means to a caller. Undefined until
   * the job is finished.
   */
  public get generationSeconds(): number | undefined {
    const { startedAt, completedAt } = this.state;
    if (!startedAt || !completedAt) return undefined;
    return Number(((completedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1));
  }
  public get isTerminal(): boolean { return isTerminal(this.state.status); }

  private transition(to: JobStatus, now: Date): void {
    if (!canTransition(this.state.status, to)) {
      throw new Error(`Illegal job transition ${this.state.status} -> ${to} for job ${this.id.value}.`);
    }
    this.state.status = to;
    this.state.updatedAt = now;
  }

  public start(now: Date): void {
    this.transition('processing', now);
    this.state.attempts += 1;
    // Only the first start. A job requeued after its worker died is still the
    // same generation, and restarting the clock would report a resumed job as
    // faster than it was.
    this.state.startedAt ??= now;
  }

  /** Worker died mid-job; BullMQ requeues it. Progress is retained for the resume. */
  public requeue(now: Date): void {
    this.transition('queued', now);
    this.state.stage = null;
  }

  public advanceTo(stage: string, progress: Progress, now: Date): void {
    if (this.state.status !== 'processing') {
      throw new Error(`Cannot advance a job that is '${this.state.status}' (job ${this.id.value}).`);
    }
    this.state.stage = stage;
    // Monotonic: a resumed job must never appear to go backwards.
    if (progress.percent >= this.state.progress.percent) this.state.progress = progress;
    this.state.updatedAt = now;
  }

  public complete(input: {
    artifacts: JobArtifacts;
    cost: GenerationCost;
    verdict: QualityVerdict | null;
    quiz: readonly QuizQuestion[];
    now: Date;
  }): void {
    this.transition('completed', input.now);
    this.state.artifacts = input.artifacts;
    this.recordCost(input.cost);
    this.state.verdict = input.verdict;
    this.state.qualityJson = input.verdict ? (input.verdict.toJSON() as Record<string, unknown>) : null;
    this.state.quiz = input.quiz;
    this.state.progress = Progress.of(100);
    this.state.stage = null;
    this.state.completedAt = input.now;
  }

  public fail(failure: JobFailure, now: Date, cost?: GenerationCost): void {
    this.transition('failed', now);
    this.state.failure = failure;
    this.state.failedAt = now;
    if (cost) this.recordCost(cost);
  }

  public cancel(now: Date): void {
    this.transition('cancelled', now);
    this.state.cancelledAt = now;
    this.state.stage = null;
  }

  public recordCost(cost: GenerationCost): void {
    this.state.cost = cost;
    this.state.costJson = cost.toJSON() as Record<string, unknown>;
  }

  public toSnapshot(): VideoJobSnapshot {
    const { identity: i, state: st } = this;
    return {
      id: i.id.value,
      status: st.status,
      progressPercent: st.progress.percent,
      stage: st.stage,
      outputLanguage: i.outputLanguage.code,
      voiceSlot: i.voiceSlot,
      qualityPreset: i.qualityPreset.name,
      style: i.style.name,
      direction: i.direction?.text ?? null,
      features: i.features.toJson(),
      targetDurationSeconds: i.targetDuration?.seconds ?? null,
      attempts: st.attempts,
      createdAt: i.createdAt.toISOString(),
      updatedAt: st.updatedAt.toISOString(),
      startedAt: st.startedAt?.toISOString() ?? null,
      completedAt: st.completedAt?.toISOString() ?? null,
      generationSeconds: this.generationSeconds ?? null,
      failedAt: st.failedAt?.toISOString() ?? null,
      cancelledAt: st.cancelledAt?.toISOString() ?? null,
      artifacts: st.artifacts,
      failure: st.failure,
      idempotencyKey: i.idempotencyKey ?? null,
      requestFingerprint: i.requestFingerprint ?? null,
      cost: st.costJson,
      quality: st.qualityJson,
      quiz: st.quiz.map((q) => q.toJSON()),
    };
  }

  /** Rehydration from the repository. Bypasses the state machine by design. */
  public static rehydrate(input: {
    snapshot: VideoJobSnapshot;
    qualityPreset: QualityPreset;
    style: VideoStyle;
    direction: ExtraDirection | undefined;
    features: JobFeatures;
    studentContext: StudentContext;
    cost: GenerationCost | null;
    verdict: QualityVerdict | null;
    quiz: readonly QuizQuestion[];
  }): VideoJob {
    const s = input.snapshot;
    return new VideoJob(
      {
        id: JobId.of(s.id),
        outputLanguage: Language.of(s.outputLanguage),
        voiceSlot: s.voiceSlot,
        qualityPreset: input.qualityPreset,
        style: input.style,
        direction: input.direction,
        features: input.features,
        studentContext: input.studentContext,
        targetDuration: s.targetDurationSeconds === null
          ? undefined
          : Duration.fromSeconds(s.targetDurationSeconds),
        createdAt: new Date(s.createdAt),
        idempotencyKey: s.idempotencyKey ?? undefined,
        requestFingerprint: s.requestFingerprint ?? undefined,
      },
      {
        status: s.status,
        progress: Progress.of(s.progressPercent),
        stage: s.stage,
        updatedAt: new Date(s.updatedAt),
        startedAt: s.startedAt ? new Date(s.startedAt) : null,
        completedAt: s.completedAt ? new Date(s.completedAt) : null,
        failedAt: s.failedAt ? new Date(s.failedAt) : null,
        cancelledAt: s.cancelledAt ? new Date(s.cancelledAt) : null,
        artifacts: s.artifacts,
        failure: s.failure,
        cost: input.cost,
        verdict: input.verdict,
        quiz: input.quiz,
        attempts: s.attempts,
        costJson: s.cost,
        qualityJson: s.quality,
      },
    );
  }
}

function freshState(now: Date): VideoJobState {
  return {
    status: 'queued',
    progress: Progress.zero(),
    stage: null,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    artifacts: null,
    failure: null,
    cost: null,
    verdict: null,
    quiz: [],
    attempts: 0,
    costJson: null,
    qualityJson: null,
  };
}
