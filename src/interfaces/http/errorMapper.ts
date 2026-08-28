import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { DomainError } from '@domain/error/DomainError.js';
import { InsufficientContentError } from '@domain/error/InsufficientContentError.js';
import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';

export type ApiErrorCode =
  | 'VALIDATION_ERROR' | 'IDEMPOTENCY_CONFLICT' | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT' | 'INSUFFICIENT_CONTENT'
  | 'GENERATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

export interface ApiError {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

/**
 * The single place domain errors become HTTP. No stage or use case constructs a
 * response, which is what keeps the transport concern out of the pipeline.
 *
 * GENERATION_FAILED deliberately has no HTTP mapping: the request succeeded and
 * the job failed, so it is reported through GET /status, never as a status code.
 */
function toApiError(error: unknown): ApiError {
  if (error instanceof ZodError) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'The request body failed validation.',
      details: {
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
  }

  if (error instanceof InsufficientContentError) {
    return { status: 422, code: 'INSUFFICIENT_CONTENT', message: error.message, details: { ...error.details } };
  }

  if (error instanceof UnsupportedFormatError) {
    // 415 when the *type* is wrong, 422 when a well-formed input is unusable —
    // the distinction tells the caller whether converting the file would help.
    const isTypeProblem = 'sniffed_type' in error.details;
    return {
      status: isTypeProblem ? 415 : 422,
      code: 'UNSUPPORTED_FORMAT',
      message: error.message,
      details: { ...error.details },
    };
  }

  if (error instanceof DomainError) {
    return { status: 422, code: error.code as ApiErrorCode, message: error.message, details: { ...error.details } };
  }

  // Redis unreachable is a dependency outage, not a bug in the request. 503 tells
  // the caller to retry; 500 tells them to stop, and only one of those is true.
  if (isConnectionError(error)) {
    return {
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'A required dependency is unavailable. Retry shortly.',
      details: {},
    };
  }

  if (error instanceof RangeError) {
    return { status: 400, code: 'VALIDATION_ERROR', message: error.message, details: {} };
  }

  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    // Never echo an internal message: it can carry paths, hostnames, or a
    // fragment of student content. The correlation id is how it gets debugged.
    message: 'An internal error occurred.',
    details: {},
  };
}

/** ioredis surfaces outages through a small set of recognisable shapes. */
function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'EPIPE'].includes(code)) {
    return true;
  }
  return /enableOfflineQueue|Connection is closed|Stream isn't writeable|Command timed out/i.test(error.message);
}

export async function sendError(reply: FastifyReply, error: unknown): Promise<void> {
  const api = toApiError(error);

  if (api.code === 'SERVICE_UNAVAILABLE') {
    // An expected operational condition, not a defect. Logging a full stack for
    // every request during an outage buries the one line that says what broke
    // under thousands of identical traces.
    reply.log.warn({ code: api.code }, 'dependency unavailable');
  } else if (api.status >= 500) {
    reply.log.error({ err: error }, 'unhandled error');
  } else {
    reply.log.info({ code: api.code, status: api.status }, 'request rejected');
  }

  await reply.status(api.status).send({
    error: {
      code: api.code,
      message: api.message,
      ...(Object.keys(api.details).length > 0 ? { details: api.details } : {}),
    },
  });
}
