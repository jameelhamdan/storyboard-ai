import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppInstance } from '../AppInstance.js';
// Side-effect imports: these packages augment FastifyRequest and FastifySchema
// with `parts()`/`isMultipart()` and the OpenAPI schema fields respectively.
import '@fastify/multipart';
import '@fastify/swagger';
import type { Container } from '../../composition/container.js';
import type { LoadedConfig } from '../../config/loadConfig.js';
import {
  generateRequestSchema, acceptedResponseSchema, statusResponseSchema, errorResponseSchema,
} from '../dto/schemas.js';
import { jsonSchema } from '../dto/openapi.js';
import { sendError } from '../errorMapper.js';
import { StudentContext } from '@domain/shared/StudentContext.js';
import { Language } from '@domain/shared/Language.js';
import type { SubmittedSource } from '@application/pipeline/stage/types.js';
import type { FastifyRequest } from 'fastify';
import type { GenerateRequest } from '../dto/schemas.js';

/**
 * POST /v1/generate — accepts multipart (with files) or JSON (URLs only) and
 * returns 202 + job_id immediately. The brief's own §4 requires async, which is
 * why this returns an id rather than the video URL FR-1 describes.
 */
export async function registerGenerateRoute(
  app: AppInstance,
  container: Container,
  config: LoadedConfig,
): Promise<void> {
  app.post('/v1/generate', {
    schema: {
      summary: 'Submit source material for video generation',
      description: 'Returns immediately with a job_id. Poll GET /v1/status/{job_id} for progress and results.',
      tags: ['generation'],
      consumes: ['multipart/form-data', 'application/json'],
      /**
       * Deliberately no `body` schema.
       *
       * A multipart request reaches the route as parts, not as a parsed object,
       * so Fastify body validation would reject every file upload. It would also
       * shadow zod's `.strict()` — JSON Schema permits extra properties by
       * default, so an unknown field would be silently accepted rather than
       * rejected. `generateRequestSchema` validates in the handler instead, and
       * is the single definition of the request shape either way.
       */
      response: {
        202: jsonSchema(acceptedResponseSchema, 'Job accepted and queued.'),
        200: jsonSchema(statusResponseSchema, 'Idempotency-Key replay — the original job.'),
        400: jsonSchema(errorResponseSchema, 'Malformed request.'),
        409: jsonSchema(errorResponseSchema, 'Idempotency-Key reused with a different payload.'),
        413: jsonSchema(errorResponseSchema, 'Request over the configured size limit.'),
        415: jsonSchema(errorResponseSchema, 'A file type is not supported.'),
        422: jsonSchema(errorResponseSchema, 'Well-formed but unusable input.'),
      },
    },
  }, async (request, reply) => {
    const uploadDir = join(config.env.WORKSPACE_DIR, '_uploads', randomUUID());

    try {
      const idempotencyKey = request.headers['idempotency-key'];
      const { fields, sources } = request.isMultipart()
        ? await readMultipart(request, uploadDir)
        : { fields: request.body as Record<string, unknown>, sources: [] as SubmittedSource[] };

      const parsed = generateRequestSchema.parse(normaliseFields(fields));

      for (const url of parsed.urls ?? []) {
        sources.push({
          sourceId: `url-${sources.length}`,
          origin: isYouTube(url)
            ? { type: 'youtube', url, videoId: youTubeId(url) ?? url }
            : { type: 'url', url },
        });
      }

      if (sources.length === 0) {
        return await sendError(reply, new RangeError('Provide at least one file or URL.'));
      }

      const result = await container.submitJob.execute({
        sources,
        outputLanguage: parsed.output_language,
        ...(parsed.quality_preset !== undefined ? { qualityPreset: parsed.quality_preset } : {}),
        ...(parsed.style !== undefined ? { style: parsed.style } : {}),
        ...(parsed.direction !== undefined ? { direction: parsed.direction } : {}),
        // Only the keys the caller actually sent: an absent flag has to stay
        // absent all the way to JobFeatures.resolve, which is what makes it
        // inherit rather than read as `false`.
        ...(parsed.features
          ? {
              features: {
                ...(parsed.features.images !== undefined ? { images: parsed.features.images } : {}),
                ...(parsed.features.image_sources !== undefined
                  ? { imageSources: parsed.features.image_sources }
                  : {}),
                ...(parsed.features.plan_review !== undefined
                  ? { planReview: parsed.features.plan_review }
                  : {}),
                ...(parsed.features.research !== undefined
                  ? { research: parsed.features.research }
                  : {}),
              },
            }
          : {}),
        ...(parsed.voice !== undefined ? { voiceSlot: parsed.voice } : {}),
        ...(parsed.target_duration_seconds !== undefined
          ? { targetDurationSeconds: parsed.target_duration_seconds }
          : {}),
        ...(parsed.student_context ? { studentContext: toStudentContext(parsed.student_context) } : {}),
        ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
      });

      if (result.kind === 'idempotency_conflict') {
        return await reply.status(409).send({
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'This Idempotency-Key was already used with a different payload.',
            details: { existing_job_id: result.existingJobId },
          },
        });
      }

      const job = result.job;
      // A replayed key returns the original job, including its current status —
      // 200 rather than 202 so the caller can tell a replay from a new job.
      return await reply.status(result.kind === 'existing' ? 200 : 202).send({
        job_id: job.id.value,
        status: job.status,
        created_at: job.createdAt.toISOString(),
        status_url: `/v1/status/${job.id.value}`,
      });
    } catch (error) {
      return await sendError(reply, error);
    }
  });
}

/**
 * Size and count limits are enforced by @fastify/multipart, registered with the
 * same config values — so this only has to lay the parts out on disk.
 */
async function readMultipart(
  request: FastifyRequest,
  uploadDir: string,
): Promise<{ fields: Record<string, unknown>; sources: SubmittedSource[] }> {
  const fields: Record<string, unknown> = {};
  const sources: SubmittedSource[] = [];

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const target = join(uploadDir, `${sources.length}-${sanitiseFilename(part.filename)}`);
      await mkdir(dirname(target), { recursive: true });

      const buffer = await part.toBuffer();
      await writeFile(target, buffer);

      sources.push({
        sourceId: `file-${sources.length}`,
        origin: {
          type: 'file',
          filename: part.filename,
          // Recorded but never trusted — ValidateInputsStage sniffs magic bytes.
          mimeType: part.mimetype,
          bytes: buffer.byteLength,
        },
        localPath: target,
        declaredMimeType: part.mimetype,
        sizeBytes: buffer.byteLength,
      });
    } else {
      const existing = fields[part.fieldname];
      const value = part.value;
      // Repeated field names arrive one at a time; `urls` is legitimately repeated.
      fields[part.fieldname] = existing === undefined
        ? value
        : Array.isArray(existing) ? [...existing, value] : [existing, value];
    }
  }

  return { fields, sources };
}

/** Multipart values are always strings; JSON bodies are already typed. */
function normaliseFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields };

  if (typeof out['urls'] === 'string') {
    const raw = out['urls'];
    out['urls'] = raw.trim().startsWith('[') ? JSON.parse(raw) : [raw];
  }
  if (typeof out['target_duration_seconds'] === 'string') {
    out['target_duration_seconds'] = Number(out['target_duration_seconds']);
  }
  if (typeof out['student_context'] === 'string') {
    out['student_context'] = JSON.parse(out['student_context']);
  }
  return out;
}

function toStudentContext(input: NonNullable<GenerateRequest['student_context']>): StudentContext {
  const profile = input.student_profile;
  return StudentContext.of({
    ...(input.level !== undefined ? { level: input.level } : {}),
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    ...(profile
      ? {
          profile: {
            ...(profile.name !== undefined ? { name: profile.name } : {}),
            ...(profile.age !== undefined ? { age: profile.age } : {}),
            ...(languageOrUndefined(profile.language) ? { language: languageOrUndefined(profile.language)! } : {}),
            ...(profile.strengths ? { strengths: profile.strengths } : {}),
            ...(profile.weaknesses ? { weaknesses: profile.weaknesses } : {}),
          },
        }
      : {}),
  });
}

/** Upload filenames are attacker-controlled; this one lands on disk. */
function sanitiseFilename(filename: string): string {
  return filename.replace(/[^\w.-]/g, '_').replace(/\.{2,}/g, '.').slice(0, 100) || 'upload';
}

/** A profile language we don't support is dropped rather than rejected — it is a
 *  hint about the student, not the output language, and FR-14 requires graceful
 *  degradation on every optional field. */
function languageOrUndefined(code: string | undefined): Language | undefined {
  return code ? Language.tryOf(code) : undefined;
}

function isYouTube(url: string): boolean {
  return /(?:youtube\.com|youtu\.be)/i.test(url);
}

function youTubeId(url: string): string | undefined {
  return url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1];
}
