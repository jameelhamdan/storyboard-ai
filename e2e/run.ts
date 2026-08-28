/**
 * End-to-end run: source material in, playable MP4 out.
 *
 * Exercises the whole pipeline in-process — no Redis, no HTTP — so a failure
 * points at a stage rather than at infrastructure. Which providers it uses comes
 * from .env, so the same script covers both the free stub run and the real one.
 *
 *   npm run e2e                      # the default scenario
 *   npm run e2e -- --scenario spanish
 *   npm run e2e -- --file ./lecture.pdf
 *   npm run e2e -- --no-voice        # silent narration, no TTS spend
 *
 * Every run writes to out/<timestamp>-<scenario>/ and nothing is deleted
 * afterwards, so runs can be compared against each other. Edit e2e/config.ts to
 * change what it generates.
 */
import { writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';

import { loadConfig } from '../src/interfaces/config/loadConfig.js';
import { buildContainer } from '../src/interfaces/composition/container.js';
import { createLogger } from '../src/infrastructure/observability/logger.js';
import { GenerationPipeline } from '../src/application/pipeline/GenerationPipeline.js';
import { CostMeter, DEFAULT_PRICING } from '../src/infrastructure/observability/CostMeter.js';
import { FfmpegRunner } from '../src/infrastructure/encode/FfmpegRunner.js';
import type { PipelineContext } from '../src/application/pipeline/PipelineContext.js';
import type { FinalisedJob, SubmittedSource } from '../src/application/pipeline/stage/types.js';
import { JobFeatures } from '@domain/job/JobFeatures.js';
import { VideoJob } from '../src/domain/job/VideoJob.js';
import { Language } from '../src/domain/shared/Language.js';
import { Duration } from '../src/domain/shared/Duration.js';
import { StudentContext } from '../src/domain/shared/StudentContext.js';
import { ExtraDirection } from '../src/domain/media/VideoStyle.js';
import { SCENARIOS, DEFAULT_SCENARIO, type E2eScenario } from './config.js';
import { ConsolidatedContent } from '../src/domain/content/ConsolidatedContent.js';
import { ContentChunk } from '../src/domain/content/ContentChunk.js';
import { SourceRef } from '../src/domain/content/SourceRef.js';
import { consolidatedToJson } from '../src/application/pipeline/codec.js';
import { CHECKPOINT_KEY } from '../src/application/pipeline/StageName.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] ?? 'true') : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const scenarioName = arg('scenario') ?? 'default';
const scenario: E2eScenario = SCENARIOS[scenarioName] ?? DEFAULT_SCENARIO;
const fileOverride = arg('file');

/**
 * One durable, timestamped directory per run.
 *
 * Runs used to land in a fresh mkdtemp under /tmp and the workspace was
 * reclaimed on the way out, so comparing this run against the last one meant
 * having kept the terminal scrollback. `20260827-141503-default` sorts
 * chronologically and says what produced it.
 */
const runStartedAt = new Date();
const runLabel = `${runStartedAt.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}-${scenarioName}`;
const outputRoot = arg('out') ?? join(resolve('out'), runLabel);

await mkdir(join(outputRoot, 'jobs'), { recursive: true });
await mkdir(join(outputRoot, 'artifacts'), { recursive: true });

process.env['WORKSPACE_DIR'] = join(outputRoot, 'jobs');
process.env['STORAGE_LOCAL_DIR'] = join(outputRoot, 'artifacts');

// Voice is optional. `--no-voice` forces the silent synthesiser regardless of
// what .env selects, so video generation can be exercised in full before any
// TTS plan is paid for. The timing chain stays real: the stub emits correctly
// spaced silence and genuine word timings, so anchors, retiming, subtitles and
// segment planning are all still under test — only the audio is quiet.
if (flag('no-voice')) process.env['TTS_DRIVER'] = 'stub';

/**
 * Fail before the first model call rather than eight stages in.
 *
 * A missing key used to surface as an auth error during synthesis, after the
 * script and storyboard had already been paid for.
 */
if (process.env['TTS_DRIVER'] === 'elevenlabs' && !process.env['ELEVENLABS_API_KEY']) {
  console.error('\n  TTS_DRIVER=elevenlabs but ELEVENLABS_API_KEY is unset.');
  console.error('  Set it in .env, or run with --no-voice for silent narration.\n');
  process.exit(1);
}
if (process.env['LLM_DRIVER'] === 'openai' && !process.env['OPENAI_API_KEY']) {
  console.error('\n  LLM_DRIVER=openai but OPENAI_API_KEY is unset. Set it in .env.\n');
  process.exit(1);
}

const config = loadConfig();

const logger = createLogger({
  level: process.env['E2E_LOG_LEVEL'] ?? 'warn',
  redactPaths: config.raw.logging.redactPaths,
  pretty: true,
});
const container = buildContainer(config, logger);

/**
 * Artifacts and checkpoints survive the run.
 *
 * PublishArtifactsStage discards the workspace, which is right in production —
 * an unreclaimed workspace fills the host. Here it is exactly the thing worth
 * keeping: the checkpoint holds the script, the storyboard HTML and the scene
 * previews the judge actually looked at.
 */
const workspace = container.workspace as { discard: (id: unknown) => Promise<void> };
workspace.discard = async () => {};

/** Inline text is written to a real file so the extraction path runs for real. */
async function resolveSource(): Promise<SubmittedSource> {
  const path = fileOverride ?? scenario.sourceFile;

  if (path) {
    const absolute = resolve(path);
    const info = await stat(absolute);
    const declared = absolute.endsWith('.txt') ? 'text/plain'
      : absolute.endsWith('.md') ? 'text/markdown'
      : 'application/octet-stream';

    return {
      sourceId: 'file-0',
      origin: { type: 'file', filename: basename(absolute), mimeType: declared, bytes: info.size },
      localPath: absolute,
      declaredMimeType: declared,
      sizeBytes: info.size,
    };
  }

  if (!scenario.sourceText) throw new Error('Scenario has neither sourceText nor sourceFile.');

  const txtPath = join(outputRoot, 'source.txt');
  await writeFile(txtPath, scenario.sourceText, 'utf8');
  return {
    sourceId: 'file-0',
    origin: { type: 'file', filename: 'source.txt', mimeType: 'text/plain', bytes: scenario.sourceText.length },
    localPath: txtPath,
    // Text has no magic bytes, so validation falls back to the declared type.
    declaredMimeType: 'text/plain',
    sizeBytes: scenario.sourceText.length,
  };
}

/**
 * Feeds the sample lesson straight into generation, skipping extraction.
 *
 * Writing a checkpoint that already lists the four extraction stages as complete
 * makes the pipeline skip them through the same resume path a requeued job uses
 * — no bypass branch, no second code path to keep correct.
 *
 * The point is isolation: this harness exists to exercise script → storyboard →
 * speech → render, and a failure in it should mean one of those broke. Parsing
 * a .txt we wrote ourselves proves nothing and only adds a way to fail.
 *
 * Paragraphs become chunks because that is the granularity the real consolidate
 * stage emits, and each carries a real SourceRef — source-lock (FR-9) requires
 * every narration sentence to cite something resolvable, so a fixture without
 * provenance would fail the gates for the wrong reason.
 */
async function seedExtractionCheckpoints(text: string): Promise<number> {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean);

  const chunks = paragraphs.map((paragraph, i) =>
    ContentChunk.of({
      id: `chunk-${i}`,
      text: paragraph,
      kind: 'typed_document',
      order: i,
      detectedLanguage: language,
      // 'section' rather than 'page': the fixture is prose with no pagination,
      // and claiming a page number the source does not have would put a false
      // citation into traceability.json.
      refs: [SourceRef.section('sample-0', `Paragraph ${i + 1}`)],
    }),
  );

  const content = ConsolidatedContent.of({
    chunks,
    duplicatesMerged: 0,
    sourceCount: 1,
    distinctConcepts: chunks.length,
  });

  await ctx.workspace.put(job.id, CHECKPOINT_KEY, Buffer.from(JSON.stringify({
    completed: ['validate', 'ingest', 'transcribe', 'consolidate'],
    carry: { documents: [], audioSecondsTranscribed: 0, content: consolidatedToJson(content) },
  }), 'utf8'));

  return content.stats.totalWords;
}

/** The language of the muxed subtitle track, or undefined when the MP4 has none. */
async function muxedSubtitleLanguage(path: string): Promise<string | undefined> {
  const ffmpeg = new FfmpegRunner();
  try {
    const { stdout } = await ffmpeg.probe([
      '-v', 'error',
      '-select_streams', 's',
      '-show_entries', 'stream_tags=language',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      path,
    ]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mean loudness of the muxed audio track.
 *
 * `undefined` means there is no audio stream at all; `-Infinity` means there is
 * one and it is digital silence — which is exactly what the stub synthesiser
 * produces. Conflating the two reported a perfectly good silent video as having
 * no audio track, because `volumedetect` prints `-inf` rather than a number and
 * a numeric-only regex missed it.
 */
async function meanVolumeDb(path: string): Promise<number | undefined> {
  const ffmpeg = new FfmpegRunner();
  try {
    const streams = await ffmpeg.probe([
      '-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path,
    ]);
    if (!streams.stdout.trim()) return undefined;

    // `-loglevel info` on purpose: FfmpegRunner.run forces `error`, and
    // volumedetect prints its summary at info. Without this the summary is
    // suppressed, the regex finds nothing, and a perfectly good narrated video
    // is reported as having no audio — which failed the run with exit 1.
    const result = await ffmpeg.run([
      '-i', path, '-af', 'volumedetect', '-loglevel', 'info', '-f', 'null', '-',
    ]);
    const match = /mean_volume:\s*(-inf|-?[\d.]+) dB/.exec(`${result.stderr}${result.stdout}`);
    if (!match) return undefined;
    return match[1] === '-inf' ? -Infinity : Number(match[1]);
  } catch {
    return undefined;
  }
}

/** `ExtraDirection.of` returns undefined for blank text, which the job type rejects. */
function directionFor(raw: string | undefined): { direction?: ExtraDirection } {
  const parsed = raw ? ExtraDirection.of(raw) : undefined;
  return parsed ? { direction: parsed } : {};
}

const bar = (percent: number): string => {
  const filled = Math.round(percent / 5);
  return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)}`;
};

console.log(`\n  ${scenario.name}`);
console.log(`  ${'─'.repeat(60)}`);
console.log(`  providers   llm=${config.env.LLM_DRIVER} tts=${config.env.TTS_DRIVER}`);
console.log(config.env.TTS_DRIVER === 'stub'
  ? '  narration   SILENT — timing is real, audio is not'
  : `  narration   ${config.env.ELEVENLABS_MODEL_ID} · voice slot ${scenario.voice ?? `default (${scenario.outputLanguage})`}`);
if (config.env.LLM_DRIVER === 'openai') {
  console.log(`  models      ${config.env.OPENAI_MODEL_QUALITY} (quality) · ${config.env.OPENAI_MODEL_VOLUME} (volume)`);
}
console.log(`  prompts     ${config.env.PROMPT_DIR}/`);
console.log(`  language    ${scenario.outputLanguage}   preset ${scenario.qualityPreset ?? 'standard'}   style ${scenario.style ?? config.resolved.defaultStyle.name}`);
if (scenario.direction) console.log(`  direction   "${scenario.direction}"`);
console.log(`  output      ${outputRoot}\n`);

const preset = config.resolved.presets.get(scenario.qualityPreset ?? 'standard') ?? config.resolved.defaultPreset;
const language = Language.of(scenario.outputLanguage);

const job = VideoJob.create({
  outputLanguage: language,
  voiceSlot: scenario.voice ?? config.resolved.defaultVoiceByLanguage[language.code]!,
  qualityPreset: preset,
  style: config.resolved.styles.get(scenario.style ?? '') ?? config.resolved.defaultStyle,
  ...(directionFor(scenario.direction)),
  features: JobFeatures.of(config.resolved.featureDefaults),
  studentContext: StudentContext.of({
    ...(scenario.studentContext?.level ? { level: scenario.studentContext.level } : {}),
    ...(scenario.studentContext?.goal ? { goal: scenario.studentContext.goal } : {}),
    ...(scenario.studentContext?.instructions ? { instructions: scenario.studentContext.instructions } : {}),
    ...(scenario.studentContext?.weaknesses
      ? { profile: { weaknesses: scenario.studentContext.weaknesses } }
      : {}),
  }),
  ...(scenario.targetDurationSeconds
    ? { targetDuration: Duration.fromSeconds(scenario.targetDurationSeconds) }
    : {}),
  now: new Date(),
});
job.start(new Date());

const costMeter = new CostMeter(DEFAULT_PRICING, {
  llm: config.env.LLM_DRIVER,
  tts: config.env.TTS_DRIVER,
  stt: config.env.STT_DRIVER,
  rendering: 'playwright',
  storage: 'local',
  embeddings: 'stub',
  search: 'none',
});
const started = Date.now();

const stageSeconds = new Map<string, number>();
let lastStageAt = Date.now();

const pipeline = new GenerationPipeline(container.stages, (stage, progress) => {
  const now = Date.now();
  stageSeconds.set(stage, (now - lastStageAt) / 1000);
  lastStageAt = now;

  process.stdout.write(
    `  ${stage.padEnd(18)} ${bar(progress.percent)} ${String(progress.percent).padStart(3)}%` +
    `  ${stageSeconds.get(stage)!.toFixed(1).padStart(6)}s\n`,
  );
});

const ctx: PipelineContext = {
  job,
  config: config.resolved,
  logger,
  costMeter,
  workspace: container.workspace,
  signal: new AbortController().signal,
  reportProgress: () => {},
  throwIfCancelled: () => {},
};

// Extraction is skipped unless a real file is being exercised on purpose:
// `--file` and a scenario's `sourceFile` both mean "test the extractor too".
const extractionApplies = Boolean(fileOverride ?? scenario.sourceFile) || flag('with-extraction');

try {
  if (!extractionApplies) {
    if (!scenario.sourceText) throw new Error('Scenario has neither sourceText nor sourceFile.');
    const words = await seedExtractionCheckpoints(scenario.sourceText);
    console.log(`  content     ${words} words fed straight in — extraction skipped\n`);
  }

  const sources = extractionApplies ? [await resolveSource()] : [];
  const result = (await pipeline.run(ctx, sources)) as FinalisedJob;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const cost = costMeter.snapshot(result.artifacts.durationSeconds);

  const prefix = join(outputRoot, 'artifacts', 'generated', job.id.value);
  const videoPath = join(prefix, 'video.mp4');
  const srtPath = join(prefix, 'subtitles.srt');

  console.log(`\n  ${'─'.repeat(60)}`);
  console.log(`  generated in ${elapsed}s\n`);
  console.log(`  video      ${videoPath}`);
  console.log(`             ${(await stat(videoPath)).size.toLocaleString()} bytes · ` +
              `${result.artifacts.durationSeconds.toFixed(1)}s · ${preset.resolution}@${preset.fps}fps`);
  console.log(`  subtitles  ${srtPath}`);
  console.log(`  trace      ${join(prefix, 'traceability.json')}`);
  console.log(`  cost       ${join(prefix, 'cost.json')}\n`);

  // Whether the narration is actually audible, measured rather than assumed.
  // A TTS misconfiguration that returns empty audio otherwise produces a video
  // that looks completely fine and plays silent.
  const loudness = await meanVolumeDb(videoPath);
  const expectedAudible = config.env.TTS_DRIVER !== 'stub';
  const audible = loudness !== undefined && loudness > -60;

  const loudnessLabel = loudness === undefined
    ? 'NO AUDIO STREAM'
    : loudness === -Infinity ? 'silent track' : `mean ${loudness.toFixed(1)} dBFS`;

  console.log(`  audio      ${loudnessLabel}` +
              ` ${audible === expectedAudible ? '✓' : '✗'} ` +
              `${expectedAudible ? 'narration expected' : 'silence expected (stub TTS)'}`);
  if (expectedAudible && !audible) {
    console.error('\n  TTS produced no audible narration. The video is silent.\n');
    await container.close();
    process.exit(1);
  }

  // The muxed subtitle track, confirmed from the container rather than assumed —
  // a wrong mux flag produces a video that plays fine and carries no text.
  const subtitleTrack = await muxedSubtitleLanguage(videoPath);
  console.log(`  subs       ${subtitleTrack
    ? `muxed track (${subtitleTrack}) + sidecar .srt \u2713`
    : 'sidecar .srt only \u2717 no track in the MP4'}`);

  const srt = await readFile(srtPath, 'utf8');
  console.log('  first subtitle cues');
  console.log(srt.split('\r\n\r\n').slice(0, 2).map((c) => c.split('\r\n').map((l) => `    ${l}`).join('\n')).join('\n\n'));

  console.log(`\n  quiz (${result.quiz.length} questions)`);
  for (const q of result.quiz.slice(0, 3)) {
    console.log(`    [${String(q.sourceMomentSeconds).padStart(4)}s] ${q.question}`);
  }

  const gateFailures = result.verdict.failuresByGate;
  console.log(`\n  quality    holistic ${result.verdict.holisticMean?.value ?? 'n/a'} · ` +
              `regenerated ${result.verdict.scenesRegenerated} · fallback ${result.verdict.scenesFallback}`);

  // Judge-stage fallbacks are only half the story: a scene the model failed to
  // produce at all is swapped for the built-in board at storyboard time,
  // which the verdict never sees. Reporting only the verdict made a run of
  // mostly-stub scenes print "fallback 0".
  const total = result.verdict.scenes.length;
  const builtIn = result.verdict.scenesBuiltInLayout;
  console.log(`  scenes     ${total} total · ${builtIn} using the built-in board · ` +
              `${total - builtIn} model-authored`);
  console.log(`  gates      ${Object.entries(gateFailures).map(([g, n]) => `${g}:${n}`).join(' ')} (failures)`);

  const perMinute = cost.perMinute.usd;
  const target = config.resolved.costTargetPerMinuteUsd;
  console.log(`\n  cost       $${cost.total.toUsdRounded(4)} total · ` +
              `$${perMinute.toFixed(4)}/video-min ` +
              `${perMinute <= target ? '✓ within' : '✗ OVER'} the $${target.toFixed(2)} target`);
  console.log(`  units      ${JSON.stringify(cost.breakdown.totalUnits())}`);

  // Where the wall clock actually went. Render dominates by design; anything
  // else at the top of this list is worth a second look.
  const slowest = [...stageSeconds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  console.log(`\n  time       ${elapsed}s total · ${(result.artifacts.durationSeconds / Number(elapsed)).toFixed(2)}x realtime`);
  console.log(`  slowest    ${slowest.map(([stage, secs]) => `${stage} ${secs.toFixed(1)}s`).join(' · ')}`);

  await writeFile(
    join(outputRoot, 'timing.json'),
    JSON.stringify({
      scenario: scenario.name,
      started_at: runStartedAt.toISOString(),
      generation_seconds: Number(elapsed),
      video_duration_seconds: result.artifacts.durationSeconds,
      realtime_factor: Number((result.artifacts.durationSeconds / Number(elapsed)).toFixed(3)),
      providers: { llm: config.env.LLM_DRIVER, tts: config.env.TTS_DRIVER, stt: config.env.STT_DRIVER },
      stage_seconds: Object.fromEntries(
        [...stageSeconds.entries()].map(([stage, secs]) => [stage, Number(secs.toFixed(2))]),
      ),
    }, null, 2),
    'utf8',
  );
  console.log(`  timing     ${join(outputRoot, 'timing.json')}`);

  console.log(`\n  open it:   open "${videoPath}"\n`);

  console.log(`  run dir    ${outputRoot}`);
  console.log(`  workspace  ${join(outputRoot, 'jobs')} (checkpoints and scene previews kept)\n`);
  await container.close();
  process.exit(0);
} catch (error) {
  console.error(`\n  FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  console.error(`  ${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof Error && error.stack) {
    console.error(error.stack.split('\n').slice(1, 6).map((l) => `  ${l.trim()}`).join('\n'));
  }
  console.error('\n  Re-run with E2E_LOG_LEVEL=debug for the full pipeline log.\n');
  await container.close();
  process.exit(1);
}
