import { DomainError, type DomainErrorCode } from './DomainError.js';

/**
 * The pipeline failed after validation passed. Deliberately *not* an HTTP error:
 * the request succeeded, the job failed, and it is reported through GET /status.
 */
export class GenerationFailedError extends DomainError {
  public readonly code: DomainErrorCode = 'GENERATION_FAILED';

  constructor(
    message: string,
    public readonly stage: string,
    details: Record<string, unknown> = {},
  ) {
    super(message, { ...details, stage });
  }
}
