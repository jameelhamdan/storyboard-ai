import type { JobId } from '@domain/job/JobId.js';

export interface QueueDepth {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
}

export interface JobQueuePort {
  enqueue(id: JobId): Promise<void>;
  cancel(id: JobId): Promise<boolean>;
  depth(): Promise<QueueDepth>;
  close(): Promise<void>;
}
