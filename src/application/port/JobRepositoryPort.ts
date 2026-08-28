import type { VideoJob } from '@domain/job/VideoJob.js';
import type { JobId } from '@domain/job/JobId.js';

export interface JobRepositoryPort {
  save(job: VideoJob): Promise<void>;
  find(id: JobId): Promise<VideoJob | undefined>;

  /** Idempotency-Key -> job id, within the configured TTL. */
  findByIdempotencyKey(key: string): Promise<VideoJob | undefined>;
  rememberIdempotencyKey(key: string, id: JobId, ttlSeconds: number): Promise<void>;
}
