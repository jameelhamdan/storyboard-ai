/** Injected so time-dependent behaviour is testable without waiting for it. */
export interface ClockPort {
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
