import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyTypeProviderDefault } from 'fastify';

/**
 * Fastify's instance type is parameterised on the logger, and passing a concrete
 * pino instance (which we do, so redaction is configured in one place) narrows it
 * away from the default. Route modules take this alias so they stay compatible.
 */
export type AppInstance = FastifyInstance<
  Server<typeof IncomingMessage, typeof ServerResponse>,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger,
  FastifyTypeProviderDefault
>;
