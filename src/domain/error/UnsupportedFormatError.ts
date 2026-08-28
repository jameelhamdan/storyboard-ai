import { DomainError, type DomainErrorCode } from './DomainError.js';

/**
 * Carries the specific reason rather than a bare rejection — the brief requires
 * StudyCore be able to surface *why* an input was refused.
 */
export class UnsupportedFormatError extends DomainError {
  public readonly code: DomainErrorCode = 'UNSUPPORTED_FORMAT';

  constructor(reason: string, details: Record<string, unknown> = {}) {
    super(reason, details);
  }

  public static sniffedType(filename: string, sniffed: string | undefined): UnsupportedFormatError {
    return new UnsupportedFormatError(
      `'${filename}' is ${sniffed ?? 'of an unrecognised type'}, which is not a supported input format.`,
      { filename, sniffed_type: sniffed ?? null },
    );
  }

  public static overLimit(what: string, actual: number, limit: number): UnsupportedFormatError {
    return new UnsupportedFormatError(`${what} is ${actual}, over the limit of ${limit}.`, {
      limit_exceeded: what, actual, limit,
    });
  }
}
