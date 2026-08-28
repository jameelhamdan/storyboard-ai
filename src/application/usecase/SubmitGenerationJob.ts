import { createHash } from 'node:crypto';
import type { JobRepositoryPort } from '../port/JobRepositoryPort.js';
import type { JobQueuePort } from '../port/JobQueuePort.js';
import type { ClockPort } from '../port/ClockPort.js';
import type { WorkspacePort } from '../port/WorkspacePort.js';
import type { ResolvedConfig } from '../pipeline/ResolvedConfig.js';
import type { SubmittedSource } from '../pipeline/stage/types.js';
import { VideoJob } from '@domain/job/VideoJob.js';
import { Language } from '@domain/shared/Language.js';
import { Duration } from '@domain/shared/Duration.js';
import { StudentContext } from '@domain/shared/StudentContext.js';
import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';
import { ExtraDirection } from '@domain/media/VideoStyle.js';
import { JobFeatures, type JobFeatureFlags } from '@domain/job/JobFeatures.js';

export interface SubmitGenerationJobInput {
  readonly sources: readonly SubmittedSource[];
  readonly outputLanguage: string;
  readonly qualityPreset?: string;
  readonly style?: string;
  readonly direction?: string;
  readonly voiceSlot?: string;
  readonly targetDurationSeconds?: number;
  readonly studentContext?: StudentContext;
  /**
   * Partial on purpose: an unstated feature inherits the deployment default, so
   * a request that turns images off does not also silently turn the plan review
   * off. See JobFeatures.resolve.
   */
  readonly features?: Partial<JobFeatureFlags>;
  readonly idempotencyKey?: string;
}

export type SubmitGenerationJobResult =
  | { readonly kind: 'created'; readonly job: VideoJob }
  | { readonly kind: 'existing'; readonly job: VideoJob }
  | { readonly kind: 'idempotency_conflict'; readonly existingJobId: string };

/**
 * Validates the *shape* of a request and enqueues it. Deliberately does no
 * content work: the POST must return a job_id immediately, so anything that reads
 * bytes belongs to the worker.
 */
export class SubmitGenerationJob {
  constructor(
    private readonly repository: JobRepositoryPort,
    private readonly queue: JobQueuePort,
    private readonly workspace: WorkspacePort,
    private readonly clock: ClockPort,
    private readonly config: ResolvedConfig,
  ) {}

  public async execute(input: SubmitGenerationJobInput): Promise<SubmitGenerationJobResult> {
    const language = Language.of(input.outputLanguage);
    const fingerprint = this.fingerprint(input);

    // Same key + same payload returns the original job; same key + different
    // payload is a 409, because silently returning the wrong job is worse than
    // an error the caller can see.
    if (this.config.idempotency.enabled && input.idempotencyKey) {
      const existing = await this.repository.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return existing.requestFingerprint === fingerprint
          ? { kind: 'existing', job: existing }
          : { kind: 'idempotency_conflict', existingJobId: existing.id.value };
      }
    }

    const preset = this.resolvePreset(input.qualityPreset);
    const style = this.resolveStyle(input.style);
    const direction = input.direction ? ExtraDirection.of(input.direction) : undefined;
    const voiceSlot = this.resolveVoiceSlot(input.voiceSlot, language);

    const job = VideoJob.create({
      outputLanguage: language,
      voiceSlot,
      qualityPreset: preset,
      style,
      ...(direction ? { direction } : {}),
      features: JobFeatures.resolve(this.config.featureDefaults, input.features),
      studentContext: input.studentContext ?? StudentContext.empty(),
      ...(input.targetDurationSeconds !== undefined
        ? { targetDuration: Duration.fromSeconds(input.targetDurationSeconds) }
        : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      requestFingerprint: fingerprint,
      now: this.clock.now(),
    });

    // Sources are staged into the shared workspace before the job is queued, so
    // whichever worker picks it up can read them.
    await this.workspace.put(
      job.id,
      'submission.json',
      Buffer.from(JSON.stringify({ sources: input.sources }), 'utf8'),
    );

    await this.repository.save(job);
    if (this.config.idempotency.enabled && input.idempotencyKey) {
      await this.repository.rememberIdempotencyKey(
        input.idempotencyKey, job.id, this.config.idempotency.ttlSeconds,
      );
    }
    await this.queue.enqueue(job.id);

    return { kind: 'created', job };
  }

  /** Unknown style is a caller error, listed like an unknown preset. */
  private resolveStyle(name: string | undefined) {
    if (!name) return this.config.defaultStyle;
    const style = this.config.styles.get(name);
    if (!style) {
      throw new UnsupportedFormatError(
        `Unknown style '${name}'. Available: ${[...this.config.styles.keys()].join(', ')}.`,
        { requested: name, available: [...this.config.styles.keys()] },
      );
    }
    return style;
  }

  private resolvePreset(name: string | undefined) {
    if (!name) return this.config.defaultPreset;
    const preset = this.config.presets.get(name);
    if (!preset) {
      throw new UnsupportedFormatError(
        `Unknown quality preset '${name}'. Available: ${[...this.config.presets.keys()].join(', ')}.`,
        { requested: name, available: [...this.config.presets.keys()] },
      );
    }
    return preset;
  }

  /** FR-6: defaults to the configured female slot for the output language. */
  private resolveVoiceSlot(slot: string | undefined, language: Language): string {
    if (!slot) {
      const fallback = this.config.defaultVoiceByLanguage[language.code];
      if (!fallback) throw new Error(`No default voice configured for '${language.code}'.`);
      return fallback;
    }

    const voice = this.config.voices.get(slot);
    if (!voice) {
      throw new UnsupportedFormatError(
        `Unknown voice slot '${slot}'.`,
        { requested: slot, available: [...this.config.voices.keys()] },
      );
    }
    if (!voice.matchesLanguage(language)) {
      throw new UnsupportedFormatError(
        `Voice '${slot}' is ${voice.language.code}, but the requested output language is ${language.code}.`,
        { voice_language: voice.language.code, output_language: language.code },
      );
    }
    return slot;
  }

  /** Stable across key order so an equivalent retry is recognised as equivalent. */
  private fingerprint(input: SubmitGenerationJobInput): string {
    const canonical = {
      sources: [...input.sources]
        .map((s) => ({ origin: s.origin, size: s.sizeBytes ?? null }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      outputLanguage: input.outputLanguage,
      qualityPreset: input.qualityPreset ?? null,
      // Both shape the video, so a replayed key with a different style or
      // direction is a different request, not a retry of this one.
      style: input.style ?? null,
      direction: input.direction ?? null,
      voiceSlot: input.voiceSlot ?? null,
      // Same reasoning as style and direction: a replay asking for illustrated
      // boards is a different video from one asking for drawn ones.
      features: {
        images: input.features?.images ?? null,
        imageSources: input.features?.imageSources ?? null,
        planReview: input.features?.planReview ?? null,
        research: input.features?.research ?? null,
      },
      targetDurationSeconds: input.targetDurationSeconds ?? null,
      studentContext: input.studentContext
        ? {
            level: input.studentContext.level ?? null,
            goal: input.studentContext.goal ?? null,
            instructions: input.studentContext.instructions ?? null,
          }
        : null,
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }
}
