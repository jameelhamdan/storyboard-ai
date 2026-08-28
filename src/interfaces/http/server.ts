import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import type { AppInstance } from './AppInstance.js';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { loadConfig, type LoadedConfig } from '../config/loadConfig.js';
import { buildContainer, type Container } from '../composition/container.js';
import { createLogger } from '@infrastructure/observability/logger.js';
import { registerGenerateRoute } from './routes/generate.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerHealthRoute } from './routes/health.js';
import { sendError } from './errorMapper.js';

export async function buildServer(config: LoadedConfig): Promise<{ app: AppInstance; container: Container }> {
  const logger = createLogger({
    level: config.raw.logging.level,
    redactPaths: config.raw.logging.redactPaths,
    pretty: config.env.NODE_ENV === 'development',
  });

  const container = buildContainer(config, logger);

  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: config.resolved.input.maxRequestBytes,
    // Correct client IPs in the request log when running behind a load balancer.
    trustProxy: true,
    requestIdHeader: 'x-request-id',
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.resolved.input.maxFileBytes,
      files: config.resolved.input.maxSourcesPerRequest,
    },
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'StudyCore Generation API',
        description:
          'Turns course material into a whiteboard explainer video with subtitles, quiz questions and per-job cost metadata.',
        version: '0.1.0',
      },
      servers: [{ url: '/' }],
      tags: [
        { name: 'generation', description: 'Submit and track generation jobs' },
        { name: 'operations', description: 'Health and diagnostics' },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await registerGenerateRoute(app, container, config);
  await registerStatusRoutes(app, container);
  await registerHealthRoute(app, container);

  // Artifacts are on local disk, so the API serves them.
  registerLocalArtifactRoute(app, config.env.STORAGE_LOCAL_DIR);

  // Fastify's built-in errors (schema validation, payload limits, malformed
  // JSON) otherwise emit its own shape. The contract promises one envelope on
  // every non-2xx, so they route through the same mapper.
  app.setErrorHandler(async (error: FastifyError, _request, reply) => {
    if (error.statusCode === 413 || error.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'The request exceeds the configured size limit.',
          details: { limit_bytes: config.resolved.input.maxRequestBytes },
        },
      });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        error: { code: 'VALIDATION_ERROR', message: error.message },
      });
    }
    return sendError(reply, error);
  });

  app.setNotFoundHandler(async (request, reply) =>
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}.` },
    }),
  );

  return { app, container };
}

function registerLocalArtifactRoute(app: AppInstance, root: string): void {
  app.get<{ Params: { '*': string } }>('/artifacts/*', {
    // Hidden from /docs: artifact URLs are handed out by GET /status, and a
    // hosted bucket would serve them directly, so this is an implementation
    // detail of local storage rather than part of the contract.
    schema: { hide: true },
  }, async (request, reply) => {
    const relative = request.params['*'];
    const base = resolve(root);
    const path = resolve(base, relative);

    // The key comes from a URL; without this check it is an arbitrary-file read.
    if (path !== base && !path.startsWith(base + sep)) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid artifact path.' } });
    }

    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error('not a file');

      return reply
        .header('content-type', contentTypeFor(path))
        .header('content-length', info.size)
        .send(createReadStream(path));
    } catch {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Artifact not found.' } });
    }
  });

}

function contentTypeFor(path: string): string {
  if (path.endsWith('.mp4')) return 'video/mp4';
  if (path.endsWith('.srt')) return 'application/x-subrip';
  if (path.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

/** Entrypoint. Only runs when executed directly, so tests can import buildServer. */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const config = loadConfig();
  const { app, container } = await buildServer(config);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await container.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.env.PORT, host: config.env.HOST });
  app.log.info(
    { port: config.env.PORT, docs: `http://localhost:${config.env.PORT}/docs`, queue: config.queue },
    'api listening',
  );
}
