import type { AppInstance } from '../AppInstance.js';
import '@fastify/swagger';
import type { Container } from '../../composition/container.js';
import { healthResponseSchema } from '../dto/schemas.js';
import { jsonSchema } from '../dto/openapi.js';

/**
 * 200 when serving, 503 when a dependency is down. Redis is the only hard
 * dependency: without it the API can neither enqueue nor read job state, so a
 * 200 would be a lie that a load balancer would act on.
 */
export async function registerHealthRoute(app: AppInstance, container: Container): Promise<void> {
  app.get('/v1/health', {
    schema: {
      summary: 'Liveness and dependency check',
      tags: ['operations'],
      response: {
        200: jsonSchema(healthResponseSchema, 'All dependencies reachable.'),
        503: jsonSchema(healthResponseSchema, 'A dependency is down.'),
      },
    },
  }, async (_request, reply) => {
    const checks: Record<string, unknown> = { redis: 'unknown', storage: 'ok', queue_depth: 0 };
    let healthy = true;

    // Every probe is bounded. The queue's connection is configured with
    // unlimited retries because BullMQ requires it, which means a command issued
    // during an outage never settles — and a health endpoint that hangs is worse
    // than one that reports failure, because a load balancer reads the hang as
    // "still checking" and keeps sending traffic.
    const [redisOk, depth] = await Promise.all([
      withTimeout(container.redis.ping().then(() => true), 1500, false),
      withTimeout(container.queue.depth(), 1500, undefined),
    ]);

    checks['redis'] = redisOk ? 'ok' : 'unreachable';
    if (!redisOk) healthy = false;

    if (depth) {
      checks['queue_depth'] = depth.waiting + depth.delayed;
      checks['queue_active'] = depth.active;
    } else {
      checks['queue_depth'] = -1;
      healthy = false;
    }

    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      checks,
    });
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
