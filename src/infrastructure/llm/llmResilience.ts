import type { LoggerPort } from '@application/port/LoggerPort.js';

/**
 * Retry, timeout and JSON-recovery behaviour for LLM clients.
 *
 * Kept out of the client so that "retry 429s but never 4xx" is one decision in
 * one place — the kind of rule that silently diverges once a second vendor
 * adapter owns its own copy.
 */

/**
 * A schema-constrained response is still occasionally wrapped in a code fence
 * or prefixed with prose. Stripping that is cheaper than a regeneration, and
 * the failure is loud when it is genuinely not JSON.
 */
export function parseJson<T>(text: string, model: string): T {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  const start = cleaned.search(/[[{]/);
  const candidate = start > 0 ? cleaned.slice(start) : cleaned;

  try {
    return JSON.parse(candidate) as T;
  } catch (error) {
    throw new Error(
      `${model} returned output that is not valid JSON despite a response schema: ` +
      `${(error as Error).message}. First 200 chars: ${cleaned.slice(0, 200)}`,
    );
  }
}

/**
 * The longest a single retry will wait.
 *
 * Sized against a tokens-per-minute limit, which is the realistic reason to
 * wait this long: the window is a minute, so a cap below that turns a
 * recoverable pause into a failed job.
 */
const RETRY_CAP_MS = 70_000;

/**
 * Retries transient failures only. A 4xx means the request is wrong and will be
 * wrong again; retrying it burns the cost ceiling for nothing.
 */
export async function withRetry<T>(
  params: {
    model: string;
    maxRetries: number;
    requestTimeoutMs: number;
    logger: LoggerPort;
    signal?: AbortSignal;
  },
  call: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= params.maxRetries; attempt += 1) {
    if (params.signal?.aborted) throw new Error('Cancelled before the model request was made.');

    try {
      return await withTimeout(call(), params.requestTimeoutMs, params.model);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === params.maxRetries) break;

      // The provider's own hint wins when it gave one. Exponential backoff from
      // one second gives up after about seven, and a tokens-per-minute limit
      // resets over a minute — so guessing loses a job that waiting would have
      // completed. Jitter is added either way: several scenes judged
      // concurrently all get told the same number and would otherwise retry in
      // lockstep, re-tripping the limit together.
      const hinted = (error as { retryAfterMs?: number }).retryAfterMs;
      const backoffMs = Math.min(
        Math.max(hinted ?? 0, 2 ** attempt * 1000),
        RETRY_CAP_MS,
      ) + Math.random() * 1000;
      params.logger.warn(
        { model: params.model, attempt: attempt + 1, backoffMs: Math.round(backoffMs), err: error },
        'model call failed; retrying',
      );
      await sleep(backoffMs, params.signal);
    }
  }
  throw lastError;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, model: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${model} did not respond within ${ms}ms.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/did not respond within/i.test(message)) return true;

  const status = (error as { status?: number }).status;
  if (typeof status === 'number') return status === 429 || status >= 500;

  // undici raises a bare `TypeError: fetch failed` for every transport-level
  // problem — DNS, reset, refused — and puts the real reason in `cause`. Matching
  // only the message misses all of them, so a dropped connection ended the job
  // outright instead of being retried.
  if (/fetch failed|network|socket hang up/i.test(message)) return true;
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== error) return isRetryable(cause);

  return /\b(429|500|502|503|504)\b|rate.?limit|quota|unavailable|deadline|ECONNRESET|ETIMEDOUT/i.test(message);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Cancelled.')); }, { once: true });
  });
}
