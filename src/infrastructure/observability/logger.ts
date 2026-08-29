import { createRequire } from 'node:module';
import { pino, type Logger } from 'pino';

/**
 * Redaction is configured here rather than left to call sites, because "no
 * logging of raw student content" cannot depend on every future log
 * statement remembering. Paths come from config so a new content-carrying field
 * is a config edit, not a code change.
 */
export function createLogger(options: {
  level: string;
  redactPaths: readonly string[];
  pretty?: boolean;
}): Logger {
  return pino({
    level: options.level,
    redact: {
      paths: [...options.redactPaths],
      censor: '[redacted]',
    },
    // pino-pretty is a devDependency, so a production image legitimately lacks
    // it. Falling back to JSON is correct there; throwing would make the logger
    // the reason the service failed to boot.
    ...(options.pretty && hasPinoPretty()
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
    base: { service: 'studycore-generation' },
  });
}

function hasPinoPretty(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export type { Logger };
