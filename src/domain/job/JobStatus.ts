/** The job lifecycle. */
export const JOB_STATUSES = ['queued', 'processing', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * `processing -> queued` is the chaos-test path: a killed worker's job returns to
 * the queue rather than being lost. It is a legal transition on purpose.
 */
const ALLOWED: Readonly<Record<JobStatus, readonly JobStatus[]>> = Object.freeze({
  queued: ['processing', 'cancelled', 'failed'],
  processing: ['completed', 'failed', 'cancelled', 'queued'],
  completed: [],
  failed: [],
  cancelled: [],
});

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}
