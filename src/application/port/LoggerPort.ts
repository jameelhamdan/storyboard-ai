/**
 * Structured logging, without the application layer knowing which library
 * provides it. Deliberately narrow: five levels and a child binder is everything
 * the pipeline needs, and anything wider would start leaking pino's shape.
 *
 * Redaction is the adapter's responsibility — a port that could be configured to
 * *not* redact would make "no student content in logs" a per-call-site promise
 * rather than a structural one.
 */
interface LogMethod {
  (context: object, message?: string): void;
  (message: string): void;
}

export interface LoggerPort {
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  child(bindings: object): LoggerPort;
}
