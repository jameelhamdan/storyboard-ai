/**
 * The consuming side of the queue.
 *
 * `JobQueuePort` is how work is *submitted*; this is how it is *drained*. They
 * are separate ports because they have separate consumers — the API only ever
 * enqueues, the worker only ever consumes — and merging them would hand the API
 * a method it must never call.
 */
export interface JobConsumerPort {
  /**
   * Runs `handler` for each job. Throwing from the handler signals a retryable
   * failure and the queue requeues; returning normally marks it done.
   */
  start(handler: (jobId: string, signal: AbortSignal) => Promise<void>): void;

  onFailed(listener: (jobId: string | undefined, attempt: number, error: Error) => void): void;
  onCompleted(listener: (jobId: string) => void): void;
  onError(listener: (error: Error) => void): void;

  /** Waits for in-flight jobs so a deploy does not orphan half-rendered work. */
  close(): Promise<void>;
}
