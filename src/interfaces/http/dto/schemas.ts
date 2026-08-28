import { z } from 'zod';
import { SUPPORTED_LANGUAGES } from '@domain/shared/Language.js';
import { STUDENT_LEVELS } from '@domain/shared/StudentContext.js';
import { IMAGE_SOURCE_IDS } from '@domain/media/ImageSourceId.js';

/** Mirrors docs/api-contract.md. The OpenAPI document is generated from these. */

const studentContextSchema = z.object({
  level: z.enum(STUDENT_LEVELS).optional(),
  goal: z.string().max(500).optional(),
  instructions: z.string().max(2000).optional(),
  student_profile: z.object({
    name: z.string().max(120).optional(),
    age: z.number().int().min(3).max(120).optional(),
    language: z.string().max(10).optional(),
    strengths: z.array(z.string().max(80)).max(20).optional(),
    weaknesses: z.array(z.string().max(80)).max(20).optional(),
  }).optional(),
}).strict();

export const generateRequestSchema = z.object({
  urls: z.array(z.string().url()).max(20).optional(),
  output_language: z.enum(SUPPORTED_LANGUAGES),
  quality_preset: z.string().optional(),
  /** How the video reads and looks — see config/styles.yaml. Independent of quality_preset. */
  style: z.string().max(60).optional(),
  /**
   * Free-text steer for this one video. Capped because it is a nudge, not a
   * second brief — and because it reaches a model prompt, so its size is part
   * of the blast radius.
   */
  direction: z.string().max(500).optional(),
  /**
   * The optional halves of the pipeline. Both cost money and neither is always
   * wanted, so both are switchable per request; an unstated one inherits the
   * deployment default from config/default.yaml rather than defaulting to false,
   * so naming one feature never silently turns the other off.
   *
   * Asking for a feature the deployment cannot provide is not an error: with no
   * image library configured `images: true` still produces drawn boards. The
   * request states intent; the deployment decides what it can do.
   */
  features: z.object({
    /** Allow found photographs and published diagrams, credited, on a board. */
    images: z.boolean().optional(),
    /**
     * Which libraries may be used, in preference order. Naming one the
     * deployment has no credential for is not an error — the job gets the
     * intersection — so this is a request, not an assertion about the server.
     */
    image_sources: z.array(z.enum(IMAGE_SOURCE_IDS)).max(IMAGE_SOURCE_IDS.length).optional(),
    /** Judge the whole story before illustrating it, and revise it if rejected. */
    plan_review: z.boolean().optional(),
  }).strict().optional(),
  voice: z.string().optional(),
  target_duration_seconds: z.number().int().min(30).max(600).optional(),
  student_context: studentContextSchema.optional(),
  /** Accepted and ignored this phase — the contract reserves it. */
  webhook_url: z.string().url().optional(),
}).strict();

export const acceptedResponseSchema = z.object({
  job_id: z.string().uuid(),
  status: z.literal('queued'),
  created_at: z.string(),
  status_url: z.string(),
});

const costSchema = z.object({
  total_usd: z.number(),
  per_minute_usd: z.number(),
  breakdown: z.record(z.string(), z.number()),
  units: z.record(z.string(), z.number()).optional(),
});

const qualitySchema = z.object({
  scenes_total: z.number(),
  scenes_regenerated: z.number(),
  scenes_fallback: z.number(),
  holistic_score_mean: z.number().nullable(),
  video_score: z.number().nullable(),
  gate_failures: z.record(z.string(), z.number()).optional(),
});

const quizQuestionSchema = z.object({
  question: z.string(),
  answer: z.string(),
  source_moment_seconds: z.number(),
});

export const statusResponseSchema = z.object({
  job_id: z.string(),
  status: z.enum(['queued', 'processing', 'completed', 'failed', 'cancelled']),
  progress_percent: z.number(),
  stage: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  completed_at: z.string().nullable().optional(),
  /** Wall-clock seconds spent generating; present once completed. */
  generation_seconds: z.number().optional(),
  failed_at: z.string().nullable().optional(),
  cancelled_at: z.string().nullable().optional(),

  video_url: z.string().optional(),
  subtitle_url: z.string().optional(),
  traceability_url: z.string().optional(),
  cost_url: z.string().optional(),
  duration_seconds: z.number().optional(),
  language: z.string().optional(),
  voice: z.string().optional(),
  quality_preset: z.string().optional(),
  /** Echoed back so the caller can see what actually shaped the video. */
  style: z.string().optional(),
  direction: z.string().optional(),
  /**
   * Resolved, not echoed: what the job actually ran with after defaults were
   * applied. A caller who sent nothing still learns whether their video was
   * allowed to use images.
   */
  features: z.object({
    images: z.boolean(),
    image_sources: z.array(z.string()),
    plan_review: z.boolean(),
  }).optional(),

  cost: costSchema.optional(),
  quality: qualitySchema.optional(),
  quiz_questions: z.array(quizQuestionSchema).optional(),

  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
});

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({
    redis: z.string(),
    storage: z.string(),
    queue_depth: z.number(),
  }),
});

export type GenerateRequest = z.infer<typeof generateRequestSchema>;
