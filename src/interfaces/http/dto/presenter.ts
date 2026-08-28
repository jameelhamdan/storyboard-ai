import type { VideoJob } from '@domain/job/VideoJob.js';

/**
 * Job -> status payload. The shape is docs/api-contract.md; keeping the mapping
 * in one function means the contract has exactly one implementation to check.
 */
export function presentStatus(job: VideoJob): Record<string, unknown> {
  const s = job.toSnapshot();

  const base: Record<string, unknown> = {
    job_id: s.id,
    status: s.status,
    progress_percent: s.progressPercent,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };

  if (s.status === 'queued' || s.status === 'processing') {
    return { ...base, stage: s.stage };
  }

  if (s.status === 'failed') {
    return {
      ...base,
      failed_at: s.failedAt,
      ...(s.cost ? { cost: s.cost } : {}),
      error: s.failure
        ? {
            code: s.failure.code,
            message: s.failure.message,
            ...(Object.keys(s.failure.details).length > 0 ? { details: s.failure.details } : {}),
          }
        : { code: 'GENERATION_FAILED', message: 'The job failed without a recorded reason.' },
    };
  }

  if (s.status === 'cancelled') {
    return { ...base, cancelled_at: s.cancelledAt };
  }

  // completed
  return {
    ...base,
    completed_at: s.completedAt,
    ...(s.generationSeconds !== null ? { generation_seconds: s.generationSeconds } : {}),
    ...(s.artifacts
      ? {
          video_url: s.artifacts.videoUrl,
          subtitle_url: s.artifacts.subtitleUrl,
          traceability_url: s.artifacts.traceabilityUrl,
          cost_url: s.artifacts.costUrl,
          duration_seconds: s.artifacts.durationSeconds,
        }
      : {}),
    language: s.outputLanguage,
    voice: s.voiceSlot,
    quality_preset: s.qualityPreset,
    style: s.style,
    ...(s.direction ? { direction: s.direction } : {}),
    features: {
      images: s.features.images,
      // What the job will actually do, not what was stored: the master switch
      // being off empties the list, so the two fields cannot disagree in a way
      // a caller has to reconcile.
      image_sources: s.features.images ? [...s.features.imageSources] : [],
      plan_review: s.features.planReview,
      research: s.features.research,
    },
    ...(s.cost ? { cost: s.cost } : {}),
    ...(s.quality ? { quality: s.quality } : {}),
    quiz_questions: s.quiz,
  };
}
