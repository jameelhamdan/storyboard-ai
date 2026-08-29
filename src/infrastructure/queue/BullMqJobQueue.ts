import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { JobQueuePort, QueueDepth } from '@application/port/JobQueuePort.js';
import type { JobId } from '@domain/job/JobId.js';

export const GENERATION_QUEUE = 'generation';

/**
 * BullMQ over Redis. A proper job queue — no threading hacks,
 * no in-memory queue.
 *
 * `attempts` is set from config so a worker that dies mid-job has its job requeued
 * rather than lost, which is the chaos-test path. Checkpoints in the shared
 * workspace mean the retry resumes rather than restarting.
 */
export class BullMqJobQueue implements JobQueuePort {
  private readonly queue: Queue;

  constructor(
    connection: Redis,
    private readonly options: { maxAttempts: number; maxDepth: number },
  ) {
    this.queue = new Queue(GENERATION_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: options.maxAttempts,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400 },
      },
    });
  }

  public async enqueue(id: JobId): Promise<void> {
    // jobId = our JobId, so an accidental double-enqueue is a no-op rather than
    // two workers racing on the same job.
    await this.queue.add(GENERATION_QUEUE, { jobId: id.value }, { jobId: id.value });
  }

  public async cancel(id: JobId): Promise<boolean> {
    const job = await this.queue.getJob(id.value);
    if (!job) return false;

    const state = await job.getState();
    if (state === 'active') {
      // Cannot yank a running job out from under a worker; it notices at its next
      // stage boundary via the cancellation signal.
      return false;
    }
    await job.remove();
    return true;
  }

  public async depth(): Promise<QueueDepth> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed');
    return {
      waiting: counts['waiting'] ?? 0,
      active: counts['active'] ?? 0,
      delayed: counts['delayed'] ?? 0,
    };
  }

  /** Graceful degradation: over capacity we queue, never reject. */
  public async isOverCapacity(): Promise<boolean> {
    const { waiting, delayed } = await this.depth();
    return waiting + delayed >= this.options.maxDepth;
  }

  public async close(): Promise<void> {
    await this.queue.close();
  }
}
