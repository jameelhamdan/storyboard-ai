import type { QualityPreset } from '@domain/media/QualityPreset.js';
import type { VoiceProfile } from '@domain/media/VoiceProfile.js';
import type { Theme } from '@domain/media/Theme.js';
import type { VideoStyle } from '@domain/media/VideoStyle.js';
import type { JobFeatureFlags } from '@domain/job/JobFeatures.js';
import type { ImageSourcePolicy } from '@domain/policy/ImageSourcePolicy.js';
import type { SourceKind } from '@domain/content/ContentChunk.js';
import type { LanguageCode } from '@domain/shared/Language.js';
import type {
  DurationPolicy, SubtitleSegmentationPolicy, JudgeThresholdPolicy,
  RetryBudgetPolicy, CostCeilingPolicy, SourcePrecedencePolicy,
  ScriptScopingPolicy, PersonalisationPolicy,
} from '@domain/policy/index.js';

export interface InputLimits {
  readonly maxRequestBytes: number;
  readonly maxFileBytes: number;
  readonly maxSourcesPerRequest: number;
  readonly maxPdfPages: number;
  readonly maxMediaDurationSeconds: number;
  readonly archive: {
    readonly maxEntries: number;
    readonly maxUncompressedBytes: number;
    readonly maxCompressionRatio: number;
  };
  readonly fetch: {
    readonly timeoutMs: number;
    readonly maxRedirects: number;
    readonly maxResponseBytes: number;
    readonly allowedSchemes: readonly string[];
  };
}

export interface ContentThresholds {
  readonly minWords: number;
  readonly minDistinctConcepts: number;
  readonly dedupeSimilarityThreshold: number;
  readonly sourcePrecedence: readonly SourceKind[];
}

export interface ConcurrencyCaps {
  readonly storyboard: number;
  readonly judge: number;
  readonly speechSynthesis: number;
  readonly renderSegments: number;
}

export interface AudioSettings {
  readonly loudnessTargetLufs: number;
  readonly truePeakDb: number;
  readonly interSceneGapMs: number;
  readonly trimSilenceThresholdDb: number;
}

export interface JudgeSettings {
  readonly maxSceneRetries: number;
  readonly maxFallbackScenes: number;
  /** How many times the story plan may be sent back for a rewrite. */
  readonly maxPlanRevisions: number;
}

export interface StorageSettings {
  readonly prefix: string;
  readonly presignTtlSeconds: number;
}

/**
 * Everything behavioural, already validated and turned into domain objects.
 * Stages read this; nothing below interfaces/ ever parses YAML or touches process.env.
 */
export interface ResolvedConfig {
  readonly presets: ReadonlyMap<string, QualityPreset>;
  readonly defaultPreset: QualityPreset;
  readonly voices: ReadonlyMap<string, VoiceProfile>;
  readonly themes: ReadonlyMap<string, Theme>;
  readonly defaultTheme: Theme;
  /** How a video reads and how dense its boards are — see config/styles.yaml. */
  readonly styles: ReadonlyMap<string, VideoStyle>;
  readonly defaultStyle: VideoStyle;
  readonly legibility: {
    readonly minContrastRatio: number;
  };
  readonly defaultVoiceByLanguage: Readonly<Record<LanguageCode, string>>;

  readonly input: InputLimits;
  readonly content: ContentThresholds;
  readonly concurrency: ConcurrencyCaps;
  readonly audio: AudioSettings;
  readonly judge: JudgeSettings;
  /**
   * What a request inherits when it does not mention a feature. Capability is
   * separate: a deployment with no image library produces drawn boards whatever
   * this says — see JobFeatures.
   */
  readonly featureDefaults: JobFeatureFlags;
  readonly storage: StorageSettings;
  readonly wordsPerMinute: Readonly<Record<string, number>>;
  readonly subtitleMaxDriftMs: number;
  /** USD per video-minute the finished job is measured against. */
  readonly costTargetPerMinuteUsd: number;
  readonly jobMaxAttempts: number;
  readonly jobStateTtlSeconds: number;
  readonly idempotency: { readonly enabled: boolean; readonly ttlSeconds: number };

  readonly policies: {
    readonly duration: DurationPolicy;
    readonly subtitles: SubtitleSegmentationPolicy;
    readonly judgeThreshold: JudgeThresholdPolicy;
    readonly retryBudget: RetryBudgetPolicy;
    readonly costCeiling: CostCeilingPolicy;
    readonly sourcePrecedence: SourcePrecedencePolicy;
    /** Which image library answers which kind of question, and in what order. */
    readonly imageSource: ImageSourcePolicy;
    readonly scriptScoping: ScriptScopingPolicy;
    readonly personalisation: PersonalisationPolicy;
  };
}
