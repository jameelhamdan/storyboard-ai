import { loadConfig } from '../config/loadConfig.js';
import { buildContainer } from '../composition/container.js';
import { createLogger } from '@infrastructure/observability/logger.js';
import { JobCancelledError } from '@application/pipeline/JobCancelledError.js';
import type { OnStageComplete } from '@application/pipeline/GenerationPipeline.js';

/**
 * Worker entrypoint. Wiring only — the queue vendor lives behind JobConsumerPort
 * and is bound in the composition root, so this file names no library.
 *
 * Horizontally scalable: `docker compose up --scale worker=N` starts N of these
 * against the same queue. Concurrency *within* a worker is WORKER_CONCURRENCY
 * (.env-configurable); parallelism *across* workers is
 * --scale. Both matter — the first fills I/O wait, the second uses more cores.
 */
const config = loadConfig();
const logger = createLogger({
  level: config.raw.logging.level,
  redactPaths: config.raw.logging.redactPaths,
  pretty: config.env.NODE_ENV === 'development',
});

const container = buildContainer(config, logger);

/**
 * Progress is persisted at every stage boundary, so GET /status reflects real
 * work rather than a guess — and so a requeued job's checkpoint scan resumes
 * against accurate state.
 */
const onStageComplete: OnStageComplete = async (stage, progress, ctx) => {
  ctx.job.advanceTo(stage, progress, new Date());
  await container.repository.save(ctx.job);
};

const processor = container.buildProcessor(onStageComplete);
const consumer = container.buildConsumer();

consumer.start(async (jobId, signal) => {
  try {
    await processor.execute(jobId, signal);
  } catch (error) {
    if (error instanceof JobCancelledError) {
      logger.info({ jobId }, 'job cancelled');
      return;
    }
    throw error; // requeued; checkpoints make the retry a resume, not a restart
  }
});

consumer.onFailed((jobId, attempt, error) => {
  logger.error({ jobId, attempt, err: error }, 'job attempt failed');
});
consumer.onCompleted((jobId) => logger.info({ jobId }, 'job attempt completed'));
consumer.onError((error) => logger.error({ err: error }, 'worker error'));

// Reclaims workspaces whose worker died after the final stage. Without it, 20
// concurrent jobs eventually fill the volume and every job fails at once.
const sweeper = setInterval(() => {
  void container.sweepOrphans()
    .then((removed) => { if (removed > 0) logger.info({ removed }, 'swept orphaned workspaces'); })
    .catch((error: unknown) => logger.warn({ err: error }, 'workspace sweep failed'));
}, 300_000);

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'worker shutting down');
  clearInterval(sweeper);
  await consumer.close();
  await container.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info({
  concurrency: config.queue.workerConcurrency,
  maxAttempts: config.resolved.jobMaxAttempts,
}, 'worker ready');
