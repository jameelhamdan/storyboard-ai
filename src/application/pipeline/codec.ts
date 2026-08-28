import { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import { ContentChunk, type SourceKind } from '@domain/content/ContentChunk.js';
import { SourceDocument, type SourceOrigin } from '@domain/content/SourceDocument.js';
import { SourceRef, type SourceLocator } from '@domain/content/SourceRef.js';
import { Citation } from '@domain/content/Citation.js';
import { NarrationScript, type NarrationBrief } from '@domain/script/NarrationScript.js';
import { Scene } from '@domain/script/Scene.js';
import { toDiagramShape, type DiagramShape } from '@domain/script/DiagramShape.js';
import { Storyboard } from '@domain/script/Storyboard.js';
import { SceneTimeline, type TimelineAnchor } from '@domain/script/SceneTimeline.js';
import { WordTiming } from '@domain/media/WordTiming.js';
import { Duration } from '@domain/shared/Duration.js';
import { Language } from '@domain/shared/Language.js';
import type { QualityPreset } from '@domain/media/QualityPreset.js';
import { VisualPlan } from '@domain/media/VisualPlan.js';
import { SubtitleCue } from '@domain/media/SubtitleCue.js';
import { QuizQuestion } from '@domain/quiz/QuizQuestion.js';
import { QualityVerdict } from '@domain/quality/QualityVerdict.js';
import { HolisticScore, type GateResult } from '@domain/quality/QualityScore.js';

/**
 * JSON codecs for the values that travel between pipeline stages.
 *
 * These exist so checkpointing is real rather than nominal: §1 promises a dead
 * worker resumes from the last finished stage rather than re-paying for LLM and
 * TTS calls already made, and that promise is only worth anything if the
 * expensive stages can actually round-trip their output.
 *
 * Deliberately explicit rather than reflective. A structural clone would
 * "work" until a value object gained an invariant, then silently produce
 * objects that skip their own constructor — which is exactly the class of bug
 * that makes a resumed job subtly different from a fresh one.
 */

/* ------------------------------------------------------------------ refs */

interface RefJson { readonly sourceId: string; readonly locator: SourceLocator }

const refToJson = (ref: SourceRef): RefJson => ({ sourceId: ref.sourceId, locator: ref.locator });

function refFromJson(json: RefJson): SourceRef {
  const l = json.locator;
  switch (l.kind) {
    case 'page': return SourceRef.page(json.sourceId, l.page);
    case 'slide': return SourceRef.slide(json.sourceId, l.slide);
    case 'timestamp': return SourceRef.timestamp(json.sourceId, l.seconds);
    case 'section': return SourceRef.section(json.sourceId, l.heading);
    case 'whole': return SourceRef.whole(json.sourceId);
  }
}

/* -------------------------------------------------------------- citations */

interface CitationJson { readonly id: string; readonly refs: RefJson[]; readonly quote?: string }

const citationToJson = (c: Citation): CitationJson => ({
  id: c.id, refs: c.refs.map(refToJson), ...(c.quote ? { quote: c.quote } : {}),
});

const citationFromJson = (json: CitationJson): Citation =>
  Citation.of(json.id, json.refs.map(refFromJson), json.quote);

/* ----------------------------------------------------------------- chunks */

interface ChunkJson {
  readonly id: string; readonly text: string; readonly refs: RefJson[];
  readonly kind: SourceKind; readonly language?: string;
  readonly mediaRefs: string[]; readonly order: number;
}

const chunkToJson = (c: ContentChunk): ChunkJson => ({
  id: c.id, text: c.text, refs: c.refs.map(refToJson), kind: c.kind,
  ...(c.detectedLanguage ? { language: c.detectedLanguage.code } : {}),
  mediaRefs: [...c.mediaRefs], order: c.order,
});

const chunkFromJson = (json: ChunkJson): ContentChunk => ContentChunk.of({
  id: json.id, text: json.text, refs: json.refs.map(refFromJson), kind: json.kind,
  ...(json.language ? { detectedLanguage: Language.of(json.language) } : {}),
  mediaRefs: json.mediaRefs, order: json.order,
});

/* -------------------------------------------------------------- documents */

export interface SourceDocumentJson {
  readonly id: string; readonly origin: SourceOrigin; readonly kind: SourceKind;
  readonly chunks: ChunkJson[]; readonly language?: string; readonly warnings: string[];
}

export const documentToJson = (d: SourceDocument): SourceDocumentJson => ({
  id: d.id, origin: d.origin, kind: d.kind, chunks: d.chunks.map(chunkToJson),
  ...(d.detectedLanguage ? { language: d.detectedLanguage.code } : {}),
  warnings: [...d.extractionWarnings],
});

export const documentFromJson = (json: SourceDocumentJson): SourceDocument => SourceDocument.of({
  id: json.id, origin: json.origin, kind: json.kind, chunks: json.chunks.map(chunkFromJson),
  ...(json.language ? { detectedLanguage: Language.of(json.language) } : {}),
  extractionWarnings: json.warnings,
});

/* ------------------------------------------------------------ consolidated */

export interface ConsolidatedJson {
  readonly chunks: ChunkJson[];
  readonly duplicatesMerged: number;
  readonly sourceCount: number;
  readonly distinctConcepts: number;
  readonly conflicts: ConsolidatedContent['conflicts'];
}

export const consolidatedToJson = (c: ConsolidatedContent): ConsolidatedJson => ({
  chunks: c.chunks.map(chunkToJson),
  duplicatesMerged: c.stats.duplicatesMerged,
  sourceCount: c.stats.sourceCount,
  distinctConcepts: c.stats.distinctConcepts,
  conflicts: c.conflicts,
});

export const consolidatedFromJson = (json: ConsolidatedJson): ConsolidatedContent =>
  ConsolidatedContent.of({
    chunks: json.chunks.map(chunkFromJson),
    duplicatesMerged: json.duplicatesMerged,
    sourceCount: json.sourceCount,
    distinctConcepts: json.distinctConcepts,
    conflicts: json.conflicts,
  });

/* ----------------------------------------------------------------- scenes */

interface SceneJson {
  readonly index: number;
  readonly spokenText: string;
  readonly writtenText: string;
  readonly citations: CitationJson[];
  readonly visualIntent: DiagramShape;
  readonly html?: string;
  readonly anchors: TimelineAnchor[];
  readonly estimatedMs: number;
  readonly measuredMs?: number;
  readonly wordTimings: { word: string; start: number; end: number }[];
  readonly usedFallback: boolean;
}

const sceneToJson = (s: Scene): SceneJson => ({
  index: s.index,
  spokenText: s.spokenText,
  writtenText: s.writtenText,
  citations: s.citations.map(citationToJson),
  visualIntent: s.visualIntent,
  ...(s.html ? { html: s.html } : {}),
  anchors: [...s.timeline.anchors],
  estimatedMs: s.estimatedDuration.ms,
  ...(s.measuredDuration ? { measuredMs: s.measuredDuration.ms } : {}),
  wordTimings: s.wordTimings.map((t) => ({ word: t.word, start: t.start.ms, end: t.end.ms })),
  usedFallback: s.usedFallbackComponent,
});

function sceneFromJson(json: SceneJson): Scene {
  let scene = Scene.of({
    index: json.index,
    spokenText: json.spokenText,
    writtenText: json.writtenText,
    citations: json.citations.map(citationFromJson),
    visualIntent: toDiagramShape(json.visualIntent),
    estimatedDuration: Duration.fromMs(json.estimatedMs),
  });

  if (json.html) {
    const timeline = SceneTimeline.unresolved(json.anchors);
    scene = json.usedFallback
      ? scene.asFallbackComponent(json.html, timeline)
      : scene.withStoryboard(json.html, timeline);
  }

  // Replaying measured audio re-resolves the timeline, exactly as the live run
  // did — so a resumed job's reveal times are computed, not restored.
  if (json.measuredMs !== undefined) {
    scene = scene.withMeasuredAudio(
      Duration.fromMs(json.measuredMs),
      json.wordTimings.map((t) => WordTiming.of(t.word, t.start, t.end)),
    );
  }
  return scene;
}

/* ----------------------------------------------------------------- script */

export interface ScriptJson {
  readonly scenes: SceneJson[];
  readonly language: string;
  readonly brief: NarrationBrief;
}

export const scriptToJson = (s: NarrationScript): ScriptJson => ({
  scenes: s.scenes.map(sceneToJson), language: s.language.code, brief: s.brief,
});

export const scriptFromJson = (json: ScriptJson): NarrationScript =>
  NarrationScript.of(json.scenes.map(sceneFromJson), Language.of(json.language), json.brief);

/**
 * The storyboard is rebuilt from the script's scenes rather than stored twice:
 * it is a projection of them plus the preset, so persisting both would create
 * two sources of truth that could disagree after a resume.
 */
export const storyboardFrom = (
  script: NarrationScript, preset: QualityPreset, interSceneGapMs: number,
): Storyboard => Storyboard.of(script.scenes, preset, Duration.fromMs(interSceneGapMs));

/**
 * Stored rather than re-derived: it is a palette and a sentence per scene, so it
 * is cheap to keep, and rebuilding it would mean a second model call on resume.
 */
export interface VisualPlanJson {
  readonly palette: {
    readonly ground: string; readonly ink: string;
    readonly accents: readonly string[]; readonly muted: string;
  };
  readonly scenes: readonly {
    readonly sceneIndex: number; readonly concept: string; readonly emphasis: readonly string[];
  }[];
}

export function visualPlanToJson(plan: VisualPlan): VisualPlanJson {
  return {
    palette: {
      ground: plan.palette.ground,
      ink: plan.palette.ink,
      accents: [...plan.palette.accents],
      muted: plan.palette.muted,
    },
    scenes: plan.scenes.map((s) => ({
      sceneIndex: s.sceneIndex, concept: s.concept, emphasis: [...s.emphasis],
    })),
  };
}

export function visualPlanFromJson(json: VisualPlanJson): VisualPlan {
  return VisualPlan.of({ palette: json.palette, scenes: json.scenes });
}

/* -------------------------------------------------------------- subtitles */

interface CueJson {
  readonly index: number; readonly startMs: number;
  readonly endMs: number; readonly lines: readonly string[];
}

const cueToJson = (c: SubtitleCue): CueJson =>
  ({ index: c.index, startMs: c.start.ms, endMs: c.end.ms, lines: [...c.lines] });

const cueFromJson = (json: CueJson): SubtitleCue =>
  SubtitleCue.of(json.index, Duration.fromMs(json.startMs), Duration.fromMs(json.endMs), json.lines);

/* ------------------------------------------------------------------- quiz */

interface QuizJson {
  readonly question: string; readonly answer: string;
  readonly sourceMomentSeconds: number; readonly citations: readonly CitationJson[];
}

const quizToJson = (q: QuizQuestion): QuizJson => ({
  question: q.question, answer: q.answer,
  sourceMomentSeconds: q.sourceMomentSeconds, citations: q.citations.map(citationToJson),
});

const quizFromJson = (json: QuizJson): QuizQuestion => QuizQuestion.of({
  question: json.question, answer: json.answer,
  sourceMomentSeconds: json.sourceMomentSeconds, citations: json.citations.map(citationFromJson),
});

/* ---------------------------------------------------------------- verdict */

interface VerdictJson {
  readonly scenes: readonly {
    readonly sceneIndex: number; readonly gates: readonly GateResult[];
    readonly holistic: number | null; readonly attempt: number;
  }[];
  readonly scenesRegenerated: number;
  readonly scenesFallback: number;
  readonly scenesBuiltInLayout: number;
  readonly deterministicFailures: readonly string[];
}

const verdictToJson = (v: QualityVerdict): VerdictJson => ({
  scenes: v.scenes.map((s) => ({
    sceneIndex: s.sceneIndex, gates: s.gates.map((g) => ({ ...g })),
    holistic: s.holistic?.value ?? null, attempt: s.attempt,
  })),
  scenesRegenerated: v.scenesRegenerated,
  scenesFallback: v.scenesFallback,
  scenesBuiltInLayout: v.scenesBuiltInLayout,
  deterministicFailures: [...v.deterministicFailures],
});

const verdictFromJson = (json: VerdictJson): QualityVerdict => QualityVerdict.of({
  scenes: json.scenes.map((s) => ({
    sceneIndex: s.sceneIndex, gates: s.gates,
    holistic: s.holistic === null ? undefined : HolisticScore.of(s.holistic),
    attempt: s.attempt,
  })),
  scenesRegenerated: json.scenesRegenerated,
  scenesFallback: json.scenesFallback,
  scenesBuiltInLayout: json.scenesBuiltInLayout,
  deterministicFailures: json.deterministicFailures,
});

/* ------------------------------------------------------------ the carry */

/**
 * The whole pipeline carry, as JSON.
 *
 * Every field is optional because the carry grows as stages complete: a job
 * checkpointed after `ingest` has documents and nothing else. Writing one
 * cumulative document rather than one file per stage is what stops the script
 * and the consolidated content being re-serialised by every stage after them.
 *
 * `storyboard` is absent on purpose — it is a projection of the script plus the
 * preset, so it is rebuilt on read rather than stored as a second source of truth.
 */
export interface CarryJson {
  sources?: unknown;
  documents?: SourceDocumentJson[];
  audioSecondsTranscribed?: number;
  content?: ConsolidatedJson;
  script?: ScriptJson;
  visualPlan?: VisualPlanJson;
  verdict?: VerdictJson;
  audioKey?: string;
  totalAudioMs?: number;
  cues?: CueJson[];
  subtitleKey?: string;
  quiz?: QuizJson[];
  segmentKeys?: string[];
  renderWallSeconds?: number;
  videoKey?: string;
  durationSeconds?: number;
  sizeBytes?: number;
  /**
   * The published URLs. Written by the last stage, so it only matters in one
   * narrow case — and that case used to crash: a worker that died between the
   * final checkpoint write and marking the job complete resumed, skipped every
   * stage, and read `result.artifacts.durationSeconds` off a carry that no
   * longer had `artifacts` in it.
   */
  artifacts?: unknown;
}

/** Fields that need a domain codec; everything else is already plain JSON. */
const CARRY_FIELDS = {
  documents: {
    to: (v: readonly SourceDocument[]) => v.map(documentToJson),
    from: (j: SourceDocumentJson[]) => j.map(documentFromJson),
  },
  content: { to: consolidatedToJson, from: consolidatedFromJson },
  script: { to: scriptToJson, from: scriptFromJson },
  visualPlan: { to: visualPlanToJson, from: visualPlanFromJson },
  verdict: { to: verdictToJson, from: verdictFromJson },
  cues: {
    to: (v: readonly SubtitleCue[]) => v.map(cueToJson),
    from: (j: CueJson[]) => j.map(cueFromJson),
  },
  quiz: {
    to: (v: readonly QuizQuestion[]) => v.map(quizToJson),
    from: (j: QuizJson[]) => j.map(quizFromJson),
  },
} as const;

const PLAIN_FIELDS = [
  'sources', 'audioSecondsTranscribed', 'audioKey', 'totalAudioMs', 'subtitleKey',
  'segmentKeys', 'renderWallSeconds', 'videoKey', 'durationSeconds', 'sizeBytes',
  'artifacts',
] as const;

/* eslint-disable @typescript-eslint/no-explicit-any -- the carry is a union of every stage output; the field table is the one place that has to treat it structurally, and each entry's own codec is typed. */

export function carryToJson(carry: unknown): CarryJson {
  const source = (carry ?? {}) as Record<string, any>;
  const out: Record<string, unknown> = {};

  for (const key of PLAIN_FIELDS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  for (const [key, codec] of Object.entries(CARRY_FIELDS)) {
    const value = source[key];
    if (value !== undefined) out[key] = (codec.to as (v: any) => unknown)(value);
  }
  return out as CarryJson;
}

/**
 * Rebuilds the carry, including the storyboard projection when a script is
 * present — so a resumed stage receives exactly the object shape it would have
 * received from the stage before it.
 */
export function carryFromJson(
  json: CarryJson, preset: QualityPreset, interSceneGapMs: number,
): unknown {
  const source = json as Record<string, any>;
  const out: Record<string, unknown> = {};

  for (const key of PLAIN_FIELDS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  for (const [key, codec] of Object.entries(CARRY_FIELDS)) {
    const value = source[key];
    if (value !== undefined) out[key] = (codec.from as (v: any) => unknown)(value);
  }

  if (out['script']) {
    out['storyboard'] = storyboardFrom(out['script'] as NarrationScript, preset, interSceneGapMs);
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
