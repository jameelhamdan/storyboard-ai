import type { Redis } from 'ioredis';
import type { JobRepositoryPort } from '@application/port/JobRepositoryPort.js';
import type { ResolvedConfig } from '@application/pipeline/ResolvedConfig.js';
import { VideoJob, type VideoJobSnapshot } from '@domain/job/VideoJob.js';
import { JobId } from '@domain/job/JobId.js';
import { StudentContext } from '@domain/shared/StudentContext.js';
import { ExtraDirection } from '@domain/media/VideoStyle.js';
import { JobFeatures } from '@domain/job/JobFeatures.js';
import { QuizQuestion } from '@domain/quiz/QuizQuestion.js';

interface PersistedJob {
  readonly snapshot: VideoJobSnapshot & { readonly terminal: boolean };
  readonly studentContext: {
    level?: string; goal?: string; instructions?: string;
  } | null;
}

/**
 * Job state in Redis alongside the queue — one dependency rather than two, which
 * is the reason BullMQ was chosen over Celery in the first place.
 *
 * State expires after `job.stateTtlSeconds`, which is how long /status stays
 * pollable. The artifacts outlive it in object storage.
 */
export class RedisJobRepository implements JobRepositoryPort {
  constructor(
    private readonly redis: Redis,
    private readonly config: ResolvedConfig,
  ) {}

  /**
   * A terminal state is final. Nothing may un-terminalise a job.
   *
   * Two writers race here by design: the API marks a job `cancelled` while a
   * worker is mid-pipeline, and that worker then persists progress from its own
   * in-memory copy — which still says `processing`. Without this guard the
   * later write silently resurrects the job and the cancellation is lost.
   *
   * Done as a Lua script so the read and the write are one atomic operation;
   * a read-then-write in Node would leave exactly the window it is meant to close.
   */
  private static readonly SAVE_SCRIPT = `
    local existing = redis.call('GET', KEYS[1])
    if existing then
      local ok, decoded = pcall(cjson.decode, existing)
      if ok and decoded.snapshot and decoded.snapshot.terminal == true then
        local incoming = cjson.decode(ARGV[1])
        if not (incoming.snapshot and incoming.snapshot.terminal == true) then
          return 0
        end
      end
    end
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    return 1
  `;

  public async save(job: VideoJob): Promise<void> {
    // The snapshot already carries cost, quality and quiz as rendered JSON.
    // `terminal` is denormalised onto it so the Lua guard can read it without
    // knowing the status vocabulary.
    const payload: PersistedJob = {
      snapshot: { ...job.toSnapshot(), terminal: job.isTerminal },
      studentContext: job.studentContext.isEmpty ? null : {
        ...(job.studentContext.level ? { level: job.studentContext.level } : {}),
        ...(job.studentContext.goal ? { goal: job.studentContext.goal } : {}),
        ...(job.studentContext.instructions ? { instructions: job.studentContext.instructions } : {}),
      },
    };

    const written = await this.redis.eval(
      RedisJobRepository.SAVE_SCRIPT,
      1,
      this.key(job.id),
      JSON.stringify(payload),
      String(this.config.jobStateTtlSeconds),
    );

    if (written === 0) {
      // Not an error: the job reached a terminal state while this writer was
      // working, and that outcome wins.
      return;
    }
  }

  public async find(id: JobId): Promise<VideoJob | undefined> {
    const raw = await this.redis.get(this.key(id));
    if (!raw) return undefined;
    return this.rehydrate(JSON.parse(raw) as PersistedJob);
  }

  public async findByIdempotencyKey(key: string): Promise<VideoJob | undefined> {
    const jobId = await this.redis.get(this.idempotencyKey(key));
    if (!jobId || !JobId.isValid(jobId)) return undefined;
    return this.find(JobId.of(jobId));
  }

  public async rememberIdempotencyKey(key: string, id: JobId, ttlSeconds: number): Promise<void> {
    // NX: first writer wins, so two concurrent requests with the same key cannot
    // both believe they created the job.
    await this.redis.set(this.idempotencyKey(key), id.value, 'EX', ttlSeconds, 'NX');
  }

  private rehydrate(payload: PersistedJob): VideoJob {
    const preset = this.config.presets.get(payload.snapshot.qualityPreset) ?? this.config.defaultPreset;
    // A style removed from config after the job was queued falls back rather
    // than failing the read: the video is already described by its brief.
    const style = this.config.styles.get(payload.snapshot.style) ?? this.config.defaultStyle;

    return VideoJob.rehydrate({
      snapshot: payload.snapshot,
      qualityPreset: preset,
      style,
      direction: payload.snapshot.direction
        ? ExtraDirection.of(payload.snapshot.direction)
        : undefined,
      // A job persisted before features existed has none on its snapshot, and
      // resuming it must not change what it does — so the absent case takes the
      // deployment defaults rather than inventing `false`.
      features: JobFeatures.fromJson(payload.snapshot.features, this.config.featureDefaults),
      studentContext: payload.studentContext
        ? StudentContext.of(payload.studentContext)
        : StudentContext.empty(),
      // The live domain objects are only needed while the job is being processed;
      // for a rehydrated job the rendered JSON on the snapshot is what the status
      // payload serves, so these stay empty rather than being half-reconstructed.
      cost: null,
      verdict: null,
      quiz: payload.snapshot.quiz.map((q) => QuizQuestion.of({
        question: q.question,
        answer: q.answer,
        sourceMomentSeconds: q.source_moment_seconds,
        citations: [],
      })),
    });
  }

  private key(id: JobId): string {
    return `job:${id.value}`;
  }

  private idempotencyKey(key: string): string {
    return `idem:${key}`;
  }

}
