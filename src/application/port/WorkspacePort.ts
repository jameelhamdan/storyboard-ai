import type { Readable } from 'node:stream';
import type { JobId } from '@domain/job/JobId.js';

/**
 * A job-scoped *shared* namespace, not a local directory (plan.md §4).
 *
 * BullMQ requeues a dead worker's job to any worker, so a checkpoint written to
 * one container's /tmp does not exist in the next. Same for split rendering: the
 * assembling worker must be able to read segments another worker produced.
 */
export interface WorkspacePort {
  put(jobId: JobId, key: string, data: Readable | Buffer): Promise<void>;
  putFile(jobId: JobId, key: string, localPath: string): Promise<void>;
  get(jobId: JobId, key: string): Promise<Buffer>;
  has(jobId: JobId, key: string): Promise<boolean>;
  list(jobId: JobId, prefix: string): Promise<readonly string[]>;

  /** Materialise to local disk — ffmpeg and Playwright need real paths. */
  localCopy(jobId: JobId, key: string): Promise<string>;

  /** A local scratch path for a stage to write into before checkpointing it. */
  scratchPath(jobId: JobId, key: string): Promise<string>;

  /** Runs on every terminal transition; a sweeper catches jobs whose worker died. */
  discard(jobId: JobId): Promise<void>;
}
