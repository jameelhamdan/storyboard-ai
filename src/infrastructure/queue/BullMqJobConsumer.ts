import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { JobConsumerPort } from '@application/port/JobConsumerPort.js';
import { GENERATION_QUEUE } from './BullMqJobQueue.js';

export interface JobConsumerOptions {
  readonly concurrency: number;
  readonly stalledIntervalMs: number;
  readonly maxStalledCount: number;
  /** How often to check whether a running job has been cancelled. */
  readonly cancellationPollMs: number;
  readonly isCancelled: (jobId: string) => Promise<boolean>;
}

/**
 * Drains the BullMQ queue.
 *
 * Cancellation is cooperative: DELETE /jobs/:id marks state, this polls for it
 * and aborts the signal, and the running job stops at its next stage boundary.
 * A hard kill would leave a half-written artifact reachable in the workspace.
 */
export class BullMqJobConsumer implements JobConsumerPort {
  private worker: Worker<{ jobId: string }> | undefined;

  constructor(
    private readonly connection: Redis,
    private readonly options: JobConsumerOptions,
  ) {}

  public start(handler: (jobId: string, signal: AbortSignal) => Promise<void>): void {
    this.worker = new Worker<{ jobId: string }>(
      GENERATION_QUEUE,
      async (job: Job<{ jobId: string }>) => {
        const controller = new AbortController();
        const poll = setInterval(() => {
          void this.options.isCancelled(job.data.jobId)
            .then((cancelled) => { if (cancelled) controller.abort(); })
            .catch(() => { /* a failed check must not abort the job */ });
        }, this.options.cancellationPollMs);

        try {
          await handler(job.data.jobId, controller.signal);
        } finally {
          clearInterval(poll);
        }
      },
      {
        connection: this.connection,
        concurrency: this.options.concurrency,
        stalledInterval: this.options.stalledIntervalMs,
        // A worker killed mid-job leaves its lock to expire; BullMQ then
        // requeues. This is the chaos-test path, and why the count is non-zero.
        maxStalledCount: this.options.maxStalledCount,
      },
    );
  }

  public onFailed(listener: (jobId: string | undefined, attempt: number, error: Error) => void): void {
    this.worker?.on('failed', (job, error) => listener(job?.data?.jobId, job?.attemptsMade ?? 0, error));
  }

  public onCompleted(listener: (jobId: string) => void): void {
    this.worker?.on('completed', (job) => listener(job.data.jobId));
  }

  public onError(listener: (error: Error) => void): void {
    this.worker?.on('error', listener);
  }

  public async close(): Promise<void> {
    await this.worker?.close();
  }
}
