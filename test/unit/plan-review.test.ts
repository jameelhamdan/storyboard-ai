import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewStoryPlanStage } from '@application/pipeline/stage/ReviewStoryPlanStage.js';
import { ScriptAssembler } from '@application/pipeline/stage/ScriptAssembler.js';
import type { PipelineContext } from '@application/pipeline/PipelineContext.js';
import type { ScriptedContent } from '@application/pipeline/stage/types.js';
import type { StoryPlanJudgePort, PlanJudgement } from '@application/port/StoryPlanJudgePort.js';
import type { ScriptGeneratorPort, ScriptGenerationResult } from '@application/port/ScriptGeneratorPort.js';
import { PlanCritique, type PlanIssue } from '@domain/quality/PlanCritique.js';
import { NarrationScript } from '@domain/script/NarrationScript.js';
import { Scene } from '@domain/script/Scene.js';
import { Citation } from '@domain/content/Citation.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { Language } from '@domain/shared/Language.js';
import { Duration } from '@domain/shared/Duration.js';
import { JobFeatures } from '@domain/job/JobFeatures.js';
import { DurationPolicy } from '@domain/policy/DurationPolicy.js';
import { ScriptScopingPolicy } from '@domain/policy/ScriptScopingPolicy.js';
import { PersonalisationPolicy } from '@domain/policy/PersonalisationPolicy.js';
import { VideoStyle } from '@domain/media/VideoStyle.js';
import { StudentContext } from '@domain/shared/StudentContext.js';
import { SharedVolumeWorkspace } from '@infrastructure/storage/SharedVolumeWorkspace.js';
import { CostMeter, DEFAULT_PRICING } from '@infrastructure/observability/CostMeter.js';

const language = Language.of('en');
const citation = Citation.of('c0', [SourceRef.page('doc', 1)], 'glucose is split into pyruvate');

const brief = {
  register: 'plain', assumedPriorKnowledge: 'none', structure: 'linear',
  emphasisedTopics: [], styleNote: 'clear', explicitInstructions: undefined,
  extraDirection: undefined,
};

const content = ConsolidatedContent.of({
  chunks: [ContentChunk.of({
    id: 'c0', text: 'Glucose is split into pyruvate.', order: 0,
    refs: [SourceRef.page('doc', 1)], kind: 'typed_document', detectedLanguage: language,
  })],
  duplicatesMerged: 0, sourceCount: 1, distinctConcepts: 3,
});

const sceneNamed = (index: number, text: string) => Scene.of({
  index,
  spokenText: text,
  writtenText: text,
  sourcedText: text,
  citations: [citation],
  visualIntent: 'flow',
  estimatedDuration: Duration.fromSeconds(6),
});

const scriptSaying = (text: string) =>
  NarrationScript.of([sceneNamed(0, text)], language, brief);

/** The generator's raw shape, which the assembler turns back into a script. */
const generated = (text: string): ScriptGenerationResult => ({
  scenes: [{
    index: 0,
    sentences: [{ text, kind: 'assert', citationIds: ['c0'] }],
    narration: text,
    sourcedNarration: text,
    citationIds: ['c0'],
    visualIntent: 'flow',
  }],
  citations: [citation],
  usage: { inputTokens: 1, outputTokens: 1, model: 'stub' },
});

function judgeSaying(...verdicts: PlanCritique[]): StoryPlanJudgePort & { calls: number } {
  let call = 0;
  return {
    get calls() { return call; },
    async judgePlan(): Promise<PlanJudgement> {
      const critique = verdicts[Math.min(call, verdicts.length - 1)]!;
      call += 1;
      return { critique, usage: { inputTokens: 1, outputTokens: 1, model: 'stub' } };
    },
  };
}

function generatorReturning(...texts: string[]): ScriptGeneratorPort & { notes: string[][] } {
  let call = 0;
  const notes: string[][] = [];
  return {
    notes,
    async generate(input: { revisionNotes?: readonly string[] }): Promise<ScriptGenerationResult> {
      notes.push([...(input.revisionNotes ?? [])]);
      const text = texts[Math.min(call, texts.length - 1)]!;
      call += 1;
      return generated(text);
    },
    async regenerate() { throw new Error('not used'); },
    fallback() { throw new Error('not used'); },
  } as unknown as ScriptGeneratorPort & { notes: string[][] };
}

const issue = (note: string): PlanIssue => ({ kind: 'coverage', note });

const approved = PlanCritique.of({ approved: true, issues: [], score: 4 });
const rejected = (note: string, score = 2) =>
  PlanCritique.of({ approved: false, issues: [issue(note)], score });

async function contextFor(features: JobFeatures, maxPlanRevisions = 1): Promise<PipelineContext> {
  const noop = () => {};
  const root = await mkdtemp(join(tmpdir(), 'plan-review-'));
  const logger = {
    info: noop, warn: noop, error: noop, debug: noop,
    child: () => logger,
  } as unknown as PipelineContext['logger'];

  return {
    job: {
      outputLanguage: language,
      targetDuration: Duration.fromSeconds(60),
      studentContext: StudentContext.empty(),
      style: VideoStyle.of({
        name: 'explainer', label: 'E', narration: 'clear', visual: 'sparse',
      }),
      direction: undefined,
      features,
    } as unknown as PipelineContext['job'],
    config: {
      judge: { maxPlanRevisions },
      policies: {
        duration: new DurationPolicy({
          minSeconds: 30, maxSeconds: 600, secondsPerHundredWords: 40,
          wordsPerMinute: { en: 150 },
        }),
        scriptScoping: new ScriptScopingPolicy(),
        personalisation: new PersonalisationPolicy(),
      },
    } as unknown as PipelineContext['config'],
    logger,
    costMeter: new CostMeter(DEFAULT_PRICING, {
      llm: 'stub', tts: 'stub', stt: 'stub',
      rendering: 'ffmpeg', storage: 'local', embeddings: 'stub', images: 'none', search: 'none',
    }),
    workspace: new SharedVolumeWorkspace(root),
    signal: new AbortController().signal,
    reportProgress: noop,
    throwIfCancelled: noop,
  } as unknown as PipelineContext;
}

const inputWith = (script: NarrationScript): ScriptedContent =>
  ({ content, script, visualPlan: undefined } as unknown as ScriptedContent);

const assembler = new ScriptAssembler({ normalize: (text) => text });

/**
 * Everything downstream judges execution — whether one board is legible,
 * grounded and well composed. None of it can ask whether the video should have
 * had this scene at all. That question is settled here, where a rejection costs
 * one text call rather than an illustrated, judged and rendered video.
 */
describe('ReviewStoryPlanStage', () => {
  it('ships an approved plan untouched, without asking for a rewrite', async () => {
    const judge = judgeSaying(approved);
    const generator = generatorReturning('should not be called');
    const stage = new ReviewStoryPlanStage(judge, generator, assembler);

    const original = scriptSaying('Glucose is split into pyruvate.');
    const result = await stage.execute(
      inputWith(original),
      await contextFor(JobFeatures.of({ images: true, imageSources: ['wikimedia'], planReview: true })),
    );

    expect(result.script).toBe(original);
    expect(generator.notes).toHaveLength(0);
    expect(judge.calls).toBe(1);
  });

  it('does nothing at all when the caller turned the review off', async () => {
    const judge = judgeSaying(rejected('missing the whole second half'));
    const stage = new ReviewStoryPlanStage(judge, generatorReturning('x'), assembler);

    const original = scriptSaying('Glucose is split into pyruvate.');
    const result = await stage.execute(
      inputWith(original),
      await contextFor(JobFeatures.of({ images: true, imageSources: ['wikimedia'], planReview: false })),
    );

    expect(result.script).toBe(original);
    expect(judge.calls).toBe(0);
  });

  /** The objections are the whole point: a rewrite told nothing rerolls. */
  it('sends the judge’s objections into the revision, verbatim', async () => {
    const judge = judgeSaying(rejected('nothing covers photosynthesis'), approved);
    const generator = generatorReturning('Glucose is split into pyruvate, then oxidised.');
    const stage = new ReviewStoryPlanStage(judge, generator, assembler);

    const result = await stage.execute(
      inputWith(scriptSaying('Glucose is split into pyruvate.')),
      await contextFor(JobFeatures.of({ images: true, imageSources: ['wikimedia'], planReview: true })),
    );

    expect(generator.notes[0]).toEqual(['coverage: nothing covers photosynthesis']);
    expect(result.script.scenes[0]?.writtenText).toContain('oxidised');
  });

  /**
   * The scene judge learned this the hard way: it overwrote attempt N-1 the
   * moment attempt N returned, even when N was worse.
   */
  it('keeps the original when the revision comes back worse', async () => {
    const judge = judgeSaying(
      PlanCritique.of({ approved: false, issues: [issue('one problem')], score: 4 }),
      PlanCritique.of({
        approved: false,
        issues: [issue('one problem'), issue('and another')],
        score: 2,
      }),
    );
    const stage = new ReviewStoryPlanStage(judge, generatorReturning('A worse plan entirely.'), assembler);

    const result = await stage.execute(
      inputWith(scriptSaying('Glucose is split into pyruvate.')),
      await contextFor(JobFeatures.of({ images: true, imageSources: ['wikimedia'], planReview: true })),
    );

    expect(result.script.scenes[0]?.writtenText).toBe('Glucose is split into pyruvate.');
  });

  /**
   * A video about the right material with a weak second scene is worth more to a
   * student than a failed job.
   */
  it('ships the best plan rather than failing when the judge never approves', async () => {
    const judge = judgeSaying(rejected('still thin'));
    const stage = new ReviewStoryPlanStage(judge, generatorReturning('Another attempt.'), assembler);

    const result = await stage.execute(
      inputWith(scriptSaying('Glucose is split into pyruvate.')),
      await contextFor(JobFeatures.of({ images: true, imageSources: ['wikimedia'], planReview: true })),
    );

    expect(result.script.scenes).toHaveLength(1);
    expect(judge.calls).toBe(2);   // the original, then its one revision
  });

  it('stops at the configured revision budget', async () => {
    const judge = judgeSaying(rejected('still thin'));
    const generator = generatorReturning('Another attempt.');
    const stage = new ReviewStoryPlanStage(judge, generator, assembler);

    await stage.execute(
      inputWith(scriptSaying('Glucose is split into pyruvate.')),
      await contextFor(JobFeatures.of({ images: true, imageSources: ['wikimedia'], planReview: true }), 2),
    );

    expect(generator.notes).toHaveLength(2);
    expect(judge.calls).toBe(3);
  });
});

/**
 * A judge that ticks the approval box and then lists three problems has told us
 * about three problems. Taking the tick at face value is how a review becomes a
 * formality that always passes.
 */
describe('PlanCritique', () => {
  it('does not approve a plan that carries objections', () => {
    const critique = PlanCritique.of({ approved: true, issues: [issue('a real problem')] });
    expect(critique.approved).toBe(false);
  });

  it('drops empty notes, which are objections with nothing in them', () => {
    const critique = PlanCritique.of({
      approved: true,
      issues: [{ kind: 'scope', note: '   ' }],
    });
    expect(critique.issues).toHaveLength(0);
    expect(critique.approved).toBe(true);
  });

  it('addresses a scene-level note to its scene', () => {
    const critique = PlanCritique.of({
      approved: false,
      issues: [{ kind: 'shape', sceneIndex: 2, note: 'a comparison drawn as a flow' }],
    });
    expect(critique.notes).toEqual(['shape (scene 2): a comparison drawn as a flow']);
  });

  it('clamps the reported score into 1-5 and never gates on it', () => {
    expect(PlanCritique.of({ approved: true, issues: [], score: 9 }).score).toBe(5);
    expect(PlanCritique.of({ approved: true, issues: [], score: Number.NaN }).score).toBeUndefined();
  });
});
