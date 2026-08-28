import { z } from 'zod';
import { IMAGE_SOURCE_IDS } from '@domain/media/ImageSourceId.js';

/** Mirrors config/default.yaml. Anything absent or malformed fails at boot. */

const positive = z.number().int().positive();

export const defaultConfigSchema = z.object({
  input: z.object({
    maxRequestBytes: positive,
    maxFileBytes: positive,
    maxSourcesPerRequest: positive,
    maxPdfPages: positive,
    maxMediaDurationSeconds: positive,
    archive: z.object({
      maxEntries: positive,
      maxUncompressedBytes: positive,
      maxCompressionRatio: positive,
    }),
    fetch: z.object({
      timeoutMs: positive,
      maxRedirects: z.number().int().min(0),
      maxResponseBytes: positive,
      allowedSchemes: z.array(z.string()).min(1),
    }),
  }),
  content: z.object({
    insufficient: z.object({
      minWords: positive,
      minDistinctConcepts: positive,
    }),
    dedupeSimilarityThreshold: z.number().min(0).max(1),
    sourcePrecedence: z.array(
      z.enum(['typed_document', 'slides', 'transcript', 'ocr_photo', 'web_page']),
    ).min(1),
  }),
  storage: z.object({
    prefix: z.string(),
    presignTtlSeconds: positive,
  }),
  workspace: z.object({
    sharedVolumePath: z.string(),
    orphanSweepAfterSeconds: positive,
  }),
  pacing: z.object({ wordsPerMinute: z.record(z.string(), positive) }),
  duration: z.object({
    minSeconds: positive,
    maxSeconds: positive,
    secondsPerHundredWords: z.number().positive(),
    targetToleranceSeconds: z.number().nonnegative(),
  }).refine((d) => d.maxSeconds > d.minSeconds, {
    message: 'duration.maxSeconds must exceed duration.minSeconds',
  }),
  subtitles: z.object({
    maxCharsPerLine: positive,
    maxLines: positive,
    minCueDurationMs: positive,
    maxCueDurationMs: positive,
    interCueGapMs: z.number().int().nonnegative(),
    maxDriftMs: positive,
  }).refine((s) => s.maxCueDurationMs > s.minCueDurationMs, {
    message: 'subtitles.maxCueDurationMs must exceed minCueDurationMs',
  }),
  audio: z.object({
    loudnessTargetLufs: z.number(),
    truePeakDb: z.number(),
    interSceneGapMs: z.number().int().nonnegative(),
    trimSilenceThresholdDb: z.number(),
  }),
  judge: z.object({
    maxSceneRetries: z.number().int().nonnegative(),
    maxFallbackScenes: z.number().int().nonnegative(),
    maxPlanRevisions: z.number().int().nonnegative(),
  }),
  features: z.object({
    images: z.boolean(),
    imageSources: z.array(z.enum(IMAGE_SOURCE_IDS)),
    planReview: z.boolean(),
  }),
  concurrency: z.object({
    storyboard: positive,
    judge: positive,
    speechSynthesis: positive,
    renderSegments: positive,
  }),
  queue: z.object({
    maxDepth: positive,
    workerConcurrency: positive,
    stalledIntervalMs: positive,
  }),
  job: z.object({
    idempotency: z.object({ enabled: z.boolean(), ttlSeconds: positive }),
    costTargetPerMinuteUsd: z.number().positive(),
    costCeilingUsd: z.number().positive(),
    stateTtlSeconds: positive,
    maxAttempts: positive,
  }),
  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
    redactPaths: z.array(z.string()),
  }),
});

export const presetsConfigSchema = z.object({
  default: z.string(),
  presets: z.record(z.string(), z.object({
    width: positive,
    height: positive,
    fps: positive,
    codec: z.enum(['h264', 'h265', 'vp9']),
    crf: z.number().int().min(0).max(51),
  })),
});

/** Mirrors config/styles.yaml — how a video reads, not how many pixels it has. */
export const stylesConfigSchema = z.object({
  default: z.string(),
  styles: z.record(z.string(), z.object({
    label: z.string().optional(),
    narration: z.string().min(1),
    visual: z.string().min(1),
  })),
});

export const voicesConfigSchema = z.object({
  defaultByLanguage: z.record(z.string(), z.string()),
  slots: z.record(z.string(), z.object({
    language: z.string(),
    gender: z.enum(['female', 'male']),
    envVar: z.string(),
    label: z.string().optional(),
  })),
});

const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex colour');

/** `crisp` inherits `standard` and overrides a subset, so every field is optional. */
const themePresetSchema = z.object({
  inherits: z.string().optional(),
  board: z.object({
    background: hexColour.optional(),
    vignette: z.string().optional(),
    padding_rem: z.number().positive().optional(),
  }).optional(),
  ink: z.object({
    primary: hexColour.optional(),
    secondary: hexColour.optional(),
    accent: hexColour.optional(),
    /** Two to four. `accent` remains the primary; this adds the rest. */
    accents: z.array(hexColour).min(1).max(4).optional(),
    muted: hexColour.optional(),
  }).optional(),
  stroke: z.object({
    width_px: z.number().positive().optional(),
    linecap: z.string().optional(),
    jitter: z.number().min(0).max(1).optional(),
    corner_radius_px: z.number().nonnegative().optional(),
  }).optional(),
  type: z.object({
    family: z.string().optional(),
    fallback: z.string().optional(),
    title_rem: z.number().positive().optional(),
    body_rem: z.number().positive().optional(),
    label_rem: z.number().positive().optional(),
    min_rem: z.number().positive().optional(),
    line_height: z.number().positive().optional(),
    letter_spacing_em: z.number().optional(),
  }).optional(),
  motion: z.object({
    draw_ms_per_100px: z.number().positive().optional(),
    reveal_ms: z.number().positive().optional(),
    ease: z.string().optional(),
    stagger_ms: z.number().nonnegative().optional(),
  }).optional(),
});

export const themeConfigSchema = z.object({
  default: z.string(),
  presets: z.record(z.string(), themePresetSchema),
  legibility: z.object({
    min_contrast_ratio: z.number().positive(),
  }),
  fonts: z.object({ selfHostDir: z.string(), required: z.array(z.string()) }),
});

/**
 * .env carries secrets and deployment endpoints only — plus the two knobs brief §5
 * names explicitly and verifies as an acceptance criterion.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  CONFIG_DIR: z.string().default('config'),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Brief §5: "Queue depth and worker count configurable via .env — verified"
  QUEUE_MAX_DEPTH: z.coerce.number().int().positive().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().optional(),

  STORAGE_LOCAL_DIR: z.string().default('.workspace/artifacts'),
  STORAGE_PUBLIC_BASE_URL: z.string().default('http://localhost:3000/artifacts'),

  WORKSPACE_DIR: z.string().default('.workspace/jobs'),

  LLM_DRIVER: z.enum(['stub', 'openai', 'gemini']).default('stub'),
  /** Only read when LLM_DRIVER=openai. */
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_QUALITY: z.string().default('gpt-4.1'),
  OPENAI_MODEL_VOLUME: z.string().default('gpt-4.1'),
  /**
   * Only read when LLM_DRIVER=gemini. Prefixed per provider like the OpenAI
   * pair rather than shared as LLM_MODEL_*: the two vendors' model names are
   * not interchangeable, and one key holding whichever driver happens to be
   * selected is how a `.env` ends up asking OpenAI for `gemini-3-flash`.
   */
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL_QUALITY: z.string().default('gemini-3.1-pro-preview'),
  GEMINI_MODEL_VOLUME: z.string().default('gemini-3.7-flash'),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(5),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  /** Where prompts/*.md live. Point it elsewhere to A/B a prompt set. */
  PROMPT_DIR: z.string().default('prompts'),
  /** Re-read prompt files on every call — edit a prompt and rerun, no restart. */
  PROMPT_HOT_RELOAD: z.coerce.boolean().default(false),

  /**
   * `openai` reuses OPENAI_API_KEY — one credential for the whole pipeline. It
   * has no native word timings, so its adapter recovers them by transcribing
   * its own output; see OpenAiSpeechSynthesizer.
   */
  TTS_DRIVER: z.enum(['stub', 'openai', 'elevenlabs', 'gemini']).default('stub'),
  OPENAI_TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  /** Recovers word timings from the synthesized audio. */
  OPENAI_TTS_ALIGN_MODEL: z.string().default('whisper-1'),
  /**
   * `gemini` reuses GEMINI_API_KEY. Like OpenAI it returns no word timings, and
   * unlike OpenAI it cannot recover them on its own key — so it borrows an
   * aligner: local whisper.cpp when STT_DRIVER=whisper, the OpenAI transcription
   * endpoint when that key is present, and nothing otherwise. See
   * GeminiSpeechSynthesizer.
   */
  GEMINI_TTS_MODEL: z.string().default('gemini-2.5-flash-preview-tts'),
  ELEVENLABS_API_KEY: z.string().optional(),
  /** Multilingual by default: one voice id then serves both en and es. */
  ELEVENLABS_MODEL_ID: z.string().default('eleven_multilingual_v2'),
  ELEVENLABS_OUTPUT_FORMAT: z.string().default('mp3_44100_128'),
  TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * Off-the-shelf images for the `illustration` board.
   *
   * There is no IMAGES_DRIVER: the feature is on when a library is reachable and
   * off when none is, which is one fewer thing to keep in sync than a switch
   * that can disagree with the credentials beside it. The script stage is told
   * which it is and stops offering the shape when the answer is no.
   *
   * Wikimedia needs no key, so it takes an explicit opt-in rather than being
   * always-on — turning it on means this service starts making outbound
   * searches, and that should be a decision somebody made.
   */
  UNSPLASH_ACCESS_KEY: z.string().optional(),
  PEXELS_API_KEY: z.string().optional(),
  WIKIMEDIA_IMAGES: z.coerce.boolean().default(false),
  /**
   * Generated illustrations, on GEMINI_API_KEY.
   *
   * An explicit switch rather than key presence alone, because that key is
   * already set for the text models on most deployments — so presence would
   * silently turn on a per-image charge nobody asked for. The other libraries
   * need a credential of their own, which *is* the decision; this one does not.
   */
  IMAGE_GENERATION: z.coerce.boolean().default(false),
  GEMINI_IMAGE_MODEL: z.string().default('gemini-3-pro-image'),
  /** Generation is slower than a search by an order of magnitude. */
  IMAGE_GENERATION_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Wikimedia's API policy requires a real contact address in the User-Agent. */
  IMAGE_USER_AGENT: z.string().default('StudyCoreGenerationApi/0.1 (+https://github.com/studycore)'),
  IMAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),

  /**
   * `whisper` keeps student audio on the machine (the GDPR-preferred path);
   */
  STT_DRIVER: z.enum(['stub', 'whisper']).default('stub'),
  WHISPER_BINARY: z.string().default('whisper-cli'),
  WHISPER_MODEL_PATH: z.string().default('models/ggml-large-v3-turbo.bin'),
  WHISPER_THREADS: z.coerce.number().int().positive().default(4),
  STT_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  /**
   * Chromium for RENDERER_DRIVER=playwright. `playwright-core` ships no browser
   * on purpose: the worker image installs Debian's package instead of pulling
   * one from a vendor CDN.
   */
  CHROMIUM_PATH: z.string().optional(),

  // Voice slot -> provider voice id. Brief §4 names these keys explicitly.
  VOICE_EN_FEMALE_1: z.string().default('21m00Tcm4TlvDq8ikWAM'),
  VOICE_EN_MALE_1: z.string().default('pNInz6obpgDQGcFmaJgB'),
  VOICE_ES_FEMALE_1: z.string().default('EXAVITQu4vr4xnSDxMaL'),
  VOICE_ES_MALE_1: z.string().default('ErXwobaYiN019PkySvjV'),
});

export type EnvConfig = z.infer<typeof envSchema>;
export type DefaultConfig = z.infer<typeof defaultConfigSchema>;
