import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  defaultConfigSchema, presetsConfigSchema, voicesConfigSchema, themeConfigSchema,
  stylesConfigSchema,
  envSchema, type EnvConfig, type DefaultConfig,
} from './schema.js';
import { loadDotenv } from './loadDotenv.js';
import type { ResolvedConfig } from '@application/pipeline/ResolvedConfig.js';
import { QualityPreset } from '@domain/media/QualityPreset.js';
import { VoiceProfile } from '@domain/media/VoiceProfile.js';
import { Theme, type ThemeTokens } from '@domain/media/Theme.js';
import { VideoStyle } from '@domain/media/VideoStyle.js';
import { Language, type LanguageCode } from '@domain/shared/Language.js';
import {
  DurationPolicy, SubtitleSegmentationPolicy, JudgeThresholdPolicy,
  RetryBudgetPolicy, CostCeilingPolicy, SourcePrecedencePolicy,
  ScriptScopingPolicy, PersonalisationPolicy, ImageSourcePolicy,
} from '@domain/policy/index.js';

export interface LoadedConfig {
  readonly env: EnvConfig;
  readonly raw: DefaultConfig;
  readonly resolved: ResolvedConfig;
  /** Effective values after the .env-first override, for logging at boot. */
  readonly queue: { readonly maxDepth: number; readonly workerConcurrency: number; readonly stalledIntervalMs: number };
}

/**
 * Layered config: YAML carries behavioural spec, .env carries secrets and the two
 * knobs the brief names. Everything is validated here so no code below
 * interfaces/ ever parses YAML or reads process.env.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  if (env === process.env) loadDotenv('.env', env);
  const parsedEnv = envSchema.parse(env);
  const dir = parsedEnv.CONFIG_DIR;

  const raw = defaultConfigSchema.parse(readYaml(dir, 'default.yaml', env));
  const presetsFile = presetsConfigSchema.parse(readYaml(dir, 'presets.yaml', env));
  const voicesFile = voicesConfigSchema.parse(readYaml(dir, 'voices.yaml', env));
  const themeFile = themeConfigSchema.parse(readYaml(dir, 'theme.yaml', env));
  const stylesFile = stylesConfigSchema.parse(readYaml(dir, 'styles.yaml', env));

  const presets = new Map<string, QualityPreset>();
  for (const [name, p] of Object.entries(presetsFile.presets)) {
    presets.set(name, QualityPreset.of({ name, ...p }));
  }

  const defaultPreset = presets.get(presetsFile.default);
  if (!defaultPreset) {
    throw new Error(`presets.yaml names '${presetsFile.default}' as the default, but no such preset is defined.`);
  }

  const voices = new Map<string, VoiceProfile>();
  for (const [slot, v] of Object.entries(voicesFile.slots)) {
    const providerVoiceId = env[v.envVar];
    if (!providerVoiceId) {
      throw new Error(
        `Voice slot '${slot}' needs ${v.envVar} set. Voice ids live in .env by design (brief §4) — see .env.example.`,
      );
    }
    voices.set(slot, VoiceProfile.of({
      slot,
      language: Language.of(v.language),
      gender: v.gender,
      providerVoiceId,
      ...(v.label ? { label: v.label } : {}),
    }));
  }

  const defaultVoiceByLanguage = {} as Record<LanguageCode, string>;
  for (const [lang, slot] of Object.entries(voicesFile.defaultByLanguage)) {
    if (!Language.isSupported(lang)) {
      throw new Error(`voices.yaml: defaultByLanguage has unsupported language '${lang}'.`);
    }
    if (!voices.has(slot)) {
      throw new Error(`voices.yaml: default for '${lang}' is '${slot}', which is not a defined slot.`);
    }
    defaultVoiceByLanguage[lang] = slot;
  }
  for (const lang of Object.keys(raw.pacing.wordsPerMinute)) {
    if (Language.isSupported(lang) && !defaultVoiceByLanguage[lang]) {
      throw new Error(`No default voice configured for '${lang}', which the pacing config declares.`);
    }
  }

  const themes = new Map<string, Theme>();
  for (const name of Object.keys(themeFile.presets)) {
    themes.set(name, resolveTheme(name, themeFile.presets));
  }
  const defaultTheme = themes.get(themeFile.default);
  if (!defaultTheme) {
    throw new Error(`theme.yaml names '${themeFile.default}' as the default, but no such preset is defined.`);
  }

  const styles = new Map<string, VideoStyle>();
  for (const [name, style] of Object.entries(stylesFile.styles)) {
    styles.set(name, VideoStyle.of({
      name,
      narration: style.narration,
      visual: style.visual,
      ...(style.label !== undefined ? { label: style.label } : {}),
    }));
  }
  const defaultStyle = styles.get(stylesFile.default);
  if (!defaultStyle) {
    throw new Error(`styles.yaml names '${stylesFile.default}' as the default, but no such style is defined.`);
  }

  // .env wins where the brief names it; YAML is the fallback default.
  const queue = {
    maxDepth: parsedEnv.QUEUE_MAX_DEPTH ?? raw.queue.maxDepth,
    workerConcurrency: parsedEnv.WORKER_CONCURRENCY ?? raw.queue.workerConcurrency,
    stalledIntervalMs: raw.queue.stalledIntervalMs,
  };

  const resolved: ResolvedConfig = {
    presets,
    defaultPreset,
    voices,
    defaultVoiceByLanguage,
    themes,
    defaultTheme,
    styles,
    defaultStyle,
    legibility: {
      minContrastRatio: themeFile.legibility.min_contrast_ratio,
    },
    input: raw.input,
    content: {
      minWords: raw.content.insufficient.minWords,
      minDistinctConcepts: raw.content.insufficient.minDistinctConcepts,
      dedupeSimilarityThreshold: raw.content.dedupeSimilarityThreshold,
      sourcePrecedence: raw.content.sourcePrecedence,
    },
    concurrency: raw.concurrency,
    audio: raw.audio,
    judge: raw.judge,
    featureDefaults: raw.features,
    storage: {
      prefix: raw.storage.prefix,
      presignTtlSeconds: raw.storage.presignTtlSeconds,
    },
    wordsPerMinute: raw.pacing.wordsPerMinute,
    subtitleMaxDriftMs: raw.subtitles.maxDriftMs,
    costTargetPerMinuteUsd: raw.job.costTargetPerMinuteUsd,
    jobMaxAttempts: raw.job.maxAttempts,
    jobStateTtlSeconds: raw.job.stateTtlSeconds,
    idempotency: raw.job.idempotency,
    policies: {
      duration: new DurationPolicy({
        minSeconds: raw.duration.minSeconds,
        maxSeconds: raw.duration.maxSeconds,
        secondsPerHundredWords: raw.duration.secondsPerHundredWords,
        wordsPerMinute: raw.pacing.wordsPerMinute,
      }),
      subtitles: new SubtitleSegmentationPolicy(raw.subtitles),
      judgeThreshold: new JudgeThresholdPolicy(),
      retryBudget: new RetryBudgetPolicy({
        maxSceneRetries: raw.judge.maxSceneRetries,
        maxFallbackScenes: raw.judge.maxFallbackScenes,
      }),
      costCeiling: new CostCeilingPolicy(raw.job.costCeilingUsd),
      imageSource: new ImageSourcePolicy(),
      sourcePrecedence: new SourcePrecedencePolicy(raw.content.sourcePrecedence),
      scriptScoping: new ScriptScopingPolicy(),
      personalisation: new PersonalisationPolicy(),
    },
  };

  return { env: parsedEnv, raw, resolved, queue };
}

type ThemePresetFile = ReturnType<typeof themeConfigSchema.parse>['presets'][string];

/**
 * Resolves one theme preset, following `inherits` so a variant states only its
 * deltas. Depth is capped rather than tracked: a cycle here would hang config
 * loading, and no legitimate theme is five levels deep.
 */
function resolveTheme(name: string, presets: Record<string, ThemePresetFile>, depth = 0): Theme {
  const preset = presets[name];
  if (!preset) throw new Error(`theme.yaml: preset '${name}' is referenced but not defined.`);
  if (depth > 5) throw new Error(`theme.yaml: inheritance chain for '${name}' is too deep — is there a cycle?`);

  const base = preset.inherits
    ? resolveTheme(preset.inherits, presets, depth + 1).tokens
    : undefined;

  const need = <T>(value: T | undefined, inherited: T | undefined, field: string): T => {
    const resolved = value ?? inherited;
    if (resolved === undefined) {
      throw new Error(`theme.yaml: preset '${name}' is missing '${field}' and does not inherit it.`);
    }
    return resolved;
  };

  const tokens: ThemeTokens = {
    board: {
      background: need(preset.board?.background, base?.board.background, 'board.background'),
      paddingRem: need(preset.board?.padding_rem, base?.board.paddingRem, 'board.padding_rem'),
      vignette: preset.board?.vignette ?? base?.board.vignette ?? 'none',
    },
    stroke: {
      widthPx: preset.stroke?.width_px ?? base?.stroke.widthPx ?? 3,
      linecap: preset.stroke?.linecap ?? base?.stroke.linecap ?? 'round',
      jitter: preset.stroke?.jitter ?? base?.stroke.jitter ?? 0,
      cornerRadiusPx: preset.stroke?.corner_radius_px ?? base?.stroke.cornerRadiusPx ?? 12,
    },
    ink: {
      primary: need(preset.ink?.primary, base?.ink.primary, 'ink.primary'),
      secondary: need(preset.ink?.secondary, base?.ink.secondary, 'ink.secondary'),
      accent: need(preset.ink?.accent, base?.ink.accent, 'ink.accent'),
      // A preset that names only a single accent still gets a valid set, so the
      // multi-accent tokens are always defined for the stylesheet.
      accents: preset.ink?.accents ?? base?.ink.accents
        ?? [need(preset.ink?.accent, base?.ink.accent, 'ink.accent')],
      muted: need(preset.ink?.muted, base?.ink.muted, 'ink.muted'),
    },
    type: {
      family: need(preset.type?.family, base?.type.family, 'type.family'),
      titleRem: need(preset.type?.title_rem, base?.type.titleRem, 'type.title_rem'),
      bodyRem: need(preset.type?.body_rem, base?.type.bodyRem, 'type.body_rem'),
      labelRem: need(preset.type?.label_rem, base?.type.labelRem, 'type.label_rem'),
      minRem: need(preset.type?.min_rem, base?.type.minRem, 'type.min_rem'),
      lineHeight: need(preset.type?.line_height, base?.type.lineHeight, 'type.line_height'),
      letterSpacingEm: preset.type?.letter_spacing_em ?? base?.type.letterSpacingEm ?? 0,
    },
    motion: {
      drawMsPer100px: need(preset.motion?.draw_ms_per_100px, base?.motion.drawMsPer100px, 'motion.draw_ms_per_100px'),
      revealMs: need(preset.motion?.reveal_ms, base?.motion.revealMs, 'motion.reveal_ms'),
      staggerMs: need(preset.motion?.stagger_ms, base?.motion.staggerMs, 'motion.stagger_ms'),
      ease: preset.motion?.ease ?? base?.motion.ease ?? 'cubic-bezier(0.22, 1, 0.36, 1)',
    },
  };

  return Theme.of(name, tokens);
}

/** `${VAR}` in YAML resolves from the environment — for bucket names and the like. */
function readYaml(dir: string, file: string, env: NodeJS.ProcessEnv): unknown {
  const path = join(dir, file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
  }
  const interpolated = text.replace(/\$\{(\w+)\}/g, (_, name: string) => env[name] ?? '');
  return parseYaml(interpolated);
}
