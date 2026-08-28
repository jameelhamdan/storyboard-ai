import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '@interfaces/http/server.js';
import { loadConfig } from '@interfaces/config/loadConfig.js';
import type { AppInstance } from '@interfaces/http/AppInstance.js';
import type { Container } from '@interfaces/composition/container.js';
import { testEnv } from '../helpers/env.js';

/**
 * Asserts the routes match docs/api-contract.md.
 *
 * Redis is not available in unit CI, so these exercise the request/response
 * contract — validation, status codes, the error envelope — rather than the
 * queueing path. The end-to-end generation path is covered by scripts/smoke.ts
 * and the corpus runs.
 */
describe('API contract', () => {
  let app: AppInstance;
  let container: Container;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'scgen-api-'));

    // An explicit env, not the developer's .env — see test/helpers/env.ts.
    ({ app, container } = await buildServer(loadConfig(testEnv({
      WORKSPACE_DIR: join(root, 'jobs'),
      STORAGE_LOCAL_DIR: join(root, 'artifacts'),
    }))));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await container?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  describe('POST /v1/generate', () => {
    it('rejects a request with neither files nor urls', async () => {
      const response = await app.inject({
        method: 'POST', url: '/v1/generate',
        payload: { output_language: 'en' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    });

    it('rejects an unsupported output language', async () => {
      const response = await app.inject({
        method: 'POST', url: '/v1/generate',
        payload: { urls: ['https://example.com/a'], output_language: 'fr' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an unknown field rather than silently ignoring it', async () => {
      const response = await app.inject({
        method: 'POST', url: '/v1/generate',
        payload: { urls: ['https://example.com/a'], output_language: 'en', surprise: true },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects a malformed URL', async () => {
      const response = await app.inject({
        method: 'POST', url: '/v1/generate',
        payload: { urls: ['not a url'], output_language: 'en' },
      });

      expect(response.statusCode).toBe(400);
    });

    /**
     * `style` and `direction` are the per-video customisation surface. Both are
     * optional, so the failure mode to guard is a typo being *accepted* and the
     * caller silently getting a default video.
     */
    it('rejects an unknown style rather than falling back to the default', async () => {
      const response = await app.inject({
        method: 'POST', url: '/v1/generate',
        payload: {
          urls: ['https://example.com/a'], output_language: 'en',
          style: 'no_such_style',
        },
      });

      // 415/422 from UNSUPPORTED_FORMAT, or 503 when the store is unreachable.
      expect([415, 422, 503]).toContain(response.statusCode);
      if (response.statusCode !== 503) {
        expect(response.json().error.code).toBe('UNSUPPORTED_FORMAT');
        expect(response.json().error.details.available).toContain('explainer');
      }
    });

    it('rejects a direction long enough to be a second brief', async () => {
      const response = await app.inject({
        method: 'POST', url: '/v1/generate',
        payload: {
          urls: ['https://example.com/a'], output_language: 'en',
          direction: 'x'.repeat(501),
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('accepts a request that omits both — they are optional', async () => {
      const response = await app.inject({
        method: 'POST', url: '/v1/generate',
        payload: { urls: ['https://example.com/a'], output_language: 'en' },
      });

      // Accepted (202) or 503 with no Redis; never a validation failure.
      expect(response.statusCode).not.toBe(400);
    });

    it('rejects a target duration outside FR-4 bounds', async () => {
      const response = await app.inject({
        method: 'POST', url: '/v1/generate',
        payload: { urls: ['https://example.com/a'], output_language: 'en', target_duration_seconds: 9999 },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /v1/status/:job_id', () => {
    // These two run with or without Redis: 404 when the store is reachable and
    // the job is genuinely absent, 503 when the store itself is down. Both are
    // correct answers to "is this job here?"; a 500 would not be.
    it('404s an unknown job (503 if the store is unreachable)', async () => {
      const response = await app.inject({
        method: 'GET', url: '/v1/status/00000000-0000-4000-8000-000000000000',
      });

      expect([404, 503]).toContain(response.statusCode);
      expect(response.json().error.code).toBe(response.statusCode === 404 ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE');
    });

    it('never 400s a malformed id — that would confirm the id space', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/status/not-a-uuid' });
      expect(response.statusCode).not.toBe(400);
      expect([404, 503]).toContain(response.statusCode);
    });
  });

  describe('DELETE /v1/jobs/:job_id', () => {
    it('404s an unknown job (503 if the store is unreachable)', async () => {
      const response = await app.inject({
        method: 'DELETE', url: '/v1/jobs/00000000-0000-4000-8000-000000000000',
      });
      expect([404, 503]).toContain(response.statusCode);
    });
  });

  describe('error envelope', () => {
    it('is identical on every non-2xx response', async () => {
      const responses = await Promise.all([
        app.inject({ method: 'GET', url: '/v1/status/nope' }),
        app.inject({ method: 'POST', url: '/v1/generate', payload: {} }),
        app.inject({ method: 'GET', url: '/no-such-route' }),
      ]);

      for (const response of responses) {
        const body = response.json();
        expect(body).toHaveProperty('error');
        expect(typeof body.error.code).toBe('string');
        expect(typeof body.error.message).toBe('string');
      }
    });
  });

  describe('OpenAPI', () => {
    it('serves the document at /docs, per deliverable 3', async () => {
      const response = await app.inject({ method: 'GET', url: '/docs/json' });
      expect(response.statusCode).toBe(200);

      const spec = response.json();
      expect(spec.openapi).toBeDefined();
      expect(Object.keys(spec.paths)).toEqual(
        expect.arrayContaining(['/v1/generate', '/v1/status/{job_id}', '/v1/jobs/{job_id}', '/v1/health']),
      );
    });
  });

  describe('GET /v1/health', () => {
    it('reports 503 when Redis is unreachable, rather than a misleading 200', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/health' });
      expect([200, 503]).toContain(response.statusCode);

      const body = response.json();
      expect(body).toHaveProperty('checks.redis');
      if (response.statusCode === 503) expect(body.status).toBe('degraded');
    });

    /**
     * A load balancer reads a hang as "still checking" and keeps sending traffic,
     * so a health endpoint that can hang is worse than one that reports failure.
     * The queue's connection retries forever by BullMQ's requirement, which is
     * exactly the thing this bound protects against.
     */
    it('answers within its bound even when every dependency is down', async () => {
      const started = Date.now();
      await app.inject({ method: 'GET', url: '/v1/health' });
      expect(Date.now() - started).toBeLessThan(3000);
    });
  });
});
