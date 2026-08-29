/**
 * Exactly three error codes are contractual. Everything the pipeline can
 * fail with maps onto one of them, plus the transport-level codes in the API
 * contract. One mapper in interfaces/ turns these into HTTP; no stage ever
 * constructs a response.
 */
export type DomainErrorCode =
  | 'INSUFFICIENT_CONTENT'
  | 'UNSUPPORTED_FORMAT'
  | 'GENERATION_FAILED';

export abstract class DomainError extends Error {
  public abstract readonly code: DomainErrorCode;

  /** Structured detail surfaced to the caller so StudyCore can act on it. */
  public readonly details: Readonly<Record<string, unknown>>;

  protected constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = Object.freeze({ ...details });
    Error.captureStackTrace?.(this, new.target);
  }
}
