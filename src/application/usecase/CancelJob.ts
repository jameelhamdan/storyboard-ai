import type { JobRepositoryPort } from '../port/JobRepositoryPort.js';
import type { JobQueuePort } from '../port/JobQueuePort.js';
import type { ClockPort } from '../port/ClockPort.js';
import { JobId } from '@domain/job/JobId.js';
import type { VideoJob } from '@domain/job/VideoJob.js';

export type CancelJobResult =
  | { readonly kind: 'cancelled'; readonly job: VideoJob }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'already_terminal'; readonly job: VideoJob };

/**
 * Marks the job cancelled and removes it from the queue. A job already running
 * notices at its next stage boundary — PipelineContext.throwIfCancelled() reads
 * the same state, so cancellation is cooperative rather than a kill.
 */
export class CancelJob {
  constructor(
    private readonly repository: JobRepositoryPort,
    private readonly queue: JobQueuePort,
    private readonly clock: ClockPort,
  ) {}

  public async execute(rawId: string): Promise<CancelJobResult> {
    if (!JobId.isValid(rawId)) return { kind: 'not_found' };

    const id = JobId.of(rawId);
    const job = await this.repository.find(id);
    if (!job) return { kind: 'not_found' };
    if (job.isTerminal) return { kind: 'already_terminal', job };

    job.cancel(this.clock.now());
    await this.repository.save(job);
    await this.queue.cancel(id);

    return { kind: 'cancelled', job };
  }
}
