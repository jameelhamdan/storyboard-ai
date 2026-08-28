/**
 * Cancellation is not a failure.
 *
 * It travels as an error because that is how you unwind a deep call stack, but
 * every layer that handles errors must let it through untouched — wrapping it as
 * GENERATION_FAILED loses the distinction and reports a job the caller
 * deliberately stopped as one that broke.
 */
export class JobCancelledError extends Error {
  constructor(public readonly jobId: string) {
    super(`Job ${jobId} was cancelled.`);
    this.name = 'JobCancelledError';
  }
}
