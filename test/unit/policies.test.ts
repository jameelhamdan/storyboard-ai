import { describe, it, expect } from 'vitest';
import { VideoStyle } from '@domain/media/VideoStyle.js';
import {
  DurationPolicy, SubtitleSegmentationPolicy, JudgeThresholdPolicy,
  RetryBudgetPolicy, CostCeilingPolicy, SourcePrecedencePolicy,
  ScriptScopingPolicy, PersonalisationPolicy,
} from '@domain/policy/index.js';
import { Duration } from '@domain/shared/Duration.js';
import { Money } from '@domain/shared/Money.js';
import { WordTiming } from '@domain/media/WordTiming.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { Citation } from '@domain/content/Citation.js';
import { StudentContext } from '@domain/shared/StudentContext.js';
import { GenerationCost } from '@domain/cost/GenerationCost.js';
import { CostBreakdown } from '@domain/cost/CostBreakdown.js';
import type { VolumeStatistics } from '@domain/content/ConsolidatedContent.js';
import { GATES } from '@domain/quality/QualityScore.js';

const stats = (words: number): VolumeStatistics => ({
  totalWords: words, distinctConcepts: 10, chunkCount: 5, duplicatesMerged: 0, sourceCount: 1,
});

describe('DurationPolicy', () => {
  const policy = new DurationPolicy({
    minSeconds: 120, maxSeconds: 600, secondsPerHundredWords: 40,
    wordsPerMinute: { en: 150, es: 135 },
  });

  it('scales duration with content volume', () => {
    expect(policy.targetFor(stats(1000)).seconds).toBe(400);
  });

  it('clamps to the FR-4 floor for thin content', () => {
    expect(policy.targetFor(stats(50)).seconds).toBe(120);
  });

  it('clamps to the FR-4 hard cap rather than truncating', () => {
    expect(policy.targetFor(stats(100_000)).seconds).toBe(600);
  });

  it('honours a caller hint but never outside the bounds', () => {
    expect(policy.targetFor(stats(1000), Duration.fromSeconds(300)).seconds).toBe(300);
    expect(policy.targetFor(stats(1000), Duration.fromSeconds(9999)).seconds).toBe(600);
    expect(policy.targetFor(stats(1000), Duration.fromSeconds(1)).seconds).toBe(120);
  });

  it('gives Spanish a smaller word budget for the same duration', () => {
    const target = Duration.fromSeconds(600);
    expect(policy.wordBudgetFor(target, 'es')).toBeLessThan(policy.wordBudgetFor(target, 'en'));
  });

  it('falls back to English pacing for an unconfigured language', () => {
    expect(policy.wordBudgetFor(Duration.fromSeconds(60), 'fr' as 'en')).toBe(150);
  });
});

describe('SubtitleSegmentationPolicy', () => {
  const policy = new SubtitleSegmentationPolicy({
    maxCharsPerLine: 42, maxLines: 2, minCueDurationMs: 900,
    maxCueDurationMs: 6000, interCueGapMs: 80,
  });

  const timings = (count: number, msEach = 400): WordTiming[] =>
    Array.from({ length: count }, (_, i) => WordTiming.of(`word${i}`, i * msEach, (i + 1) * msEach));

  it('returns nothing for no timings', () => {
    expect(policy.segment([])).toEqual([]);
  });

  it('never exceeds the configured line count', () => {
    for (const cue of policy.segment(timings(60))) {
      expect(cue.lines.length).toBeLessThanOrEqual(2);
    }
  });

  it('never exceeds chars per line', () => {
    for (const cue of policy.segment(timings(60))) {
      for (const line of cue.lines) expect(line.length).toBeLessThanOrEqual(42);
    }
  });

  it('enforces the minimum cue duration on a single short word', () => {
    const [cue] = policy.segment([WordTiming.of('hi', 0, 100)]);
    expect(cue!.duration.ms).toBeGreaterThanOrEqual(900);
  });

  it('caps cue duration at the maximum', () => {
    for (const cue of policy.segment(timings(40, 2000))) {
      expect(cue.duration.ms).toBeLessThanOrEqual(6000);
    }
  });

  it('produces non-overlapping cues in ascending order', () => {
    const cues = policy.segment(timings(80));
    for (let i = 0; i < cues.length - 1; i += 1) {
      expect(cues[i]!.overlaps(cues[i + 1]!)).toBe(false);
      expect(cues[i]!.start.ms).toBeLessThan(cues[i + 1]!.start.ms);
    }
  });

  it('numbers cues sequentially from the given start index', () => {
    const cues = policy.segment(timings(30), 5);
    expect(cues[0]!.index).toBe(5);
    expect(cues.at(-1)!.index).toBe(5 + cues.length - 1);
  });

  it('keeps drift inside the FR-8 100ms tolerance', () => {
    const words = timings(60);
    expect(policy.maxDriftMs(policy.segment(words), words)).toBeLessThanOrEqual(100);
  });
});

describe('JudgeThresholdPolicy', () => {
  const policy = new JudgeThresholdPolicy();

  it('passes only when every gate passes', () => {
    const all = (passed: boolean) => GATES.map((gate) => ({ gate, passed }));

    expect(policy.evaluate(all(true)).passed).toBe(true);
    expect(policy.evaluate(all(false)).passed).toBe(false);
  });

  it('reports exactly which gates failed, for targeted regeneration', () => {
    const verdict = policy.evaluate([
      { gate: 'G1', passed: true }, { gate: 'G2', passed: false },
      { gate: 'G3', passed: true }, { gate: 'G4', passed: false },
    ]);
    expect(verdict.failedGates).toEqual(['G2', 'G4']);
  });

  /**
   * G5 asked whether a scene sits with the one before it, and the judge was only
   * ever sent one screenshot — so it passed unconditionally while still costing
   * image tokens on every call.
   */
  it('no longer carries a gate that had no input', () => {
    expect(GATES).not.toContain('G5');
  });
});

describe('RetryBudgetPolicy', () => {
  const policy = new RetryBudgetPolicy({ maxSceneRetries: 2, maxFallbackScenes: 3 });

  it('regenerates while budget remains', () => {
    expect(policy.decide({ attempt: 0, failedGates: ['G2'] })).toMatchObject({ action: 'regenerate', attempt: 1 });
  });

  it('stops once the retries are spent', () => {
    const decision = policy.decide({ attempt: 2, failedGates: ['G2'] });
    expect(decision.action).toBe('stop');
    // The stage then ships the best attempt it collected. The policy no longer
    // decides *what* ships, only when to stop paying for more.
    expect(decision).toMatchObject({ reason: expect.stringContaining('G2') });
  });

  /**
   * A board failing one wording gate is close and worth another attempt; a board
   * failing three is wrong in ways a targeted retry will not converge on. Giving
   * both the same budget is how the judge became 80% of a run's wall clock.
   */
  it('spends less on a scene that failed in several ways at once', () => {
    expect(policy.decide({ attempt: 0, failedGates: ['G1', 'G2', 'G3'] }).action).toBe('regenerate');
    expect(policy.decide({ attempt: 1, failedGates: ['G1', 'G2', 'G3'] }).action).toBe('stop');
    // Whereas a single failed gate still gets the configured budget.
    expect(policy.decide({ attempt: 1, failedGates: ['G1'] }).action).toBe('regenerate');
  });

  /**
   * Checked once over the finished storyboard rather than per scene, which is
   * what lets scenes be judged concurrently — a running counter would have made
   * the outcome depend on which scene finished first.
   */
  it('fails the job only when too many scenes produced nothing renderable', () => {
    expect(policy.exceedsFallbackBudget(3)).toBeUndefined();
    expect(policy.exceedsFallbackBudget(4)).toMatch(/the limit is 3/);
  });
});

describe('CostCeilingPolicy', () => {
  const policy = new CostCeilingPolicy(2.0);
  const costOf = (usd: number) => GenerationCost.of(
    CostBreakdown.empty().with({ stage: 's', category: 'llm', provider: 'stub', amount: Money.fromUsd(usd), units: {} }),
    600,
  );

  it('does not breach at exactly the ceiling', () => {
    expect(policy.hasBreached(costOf(2.0))).toBe(false);
  });

  it('breaches above the ceiling', () => {
    expect(policy.hasBreached(costOf(2.01))).toBe(true);
  });

  it('projects a breach before the spend happens', () => {
    expect(policy.wouldBreach(costOf(1.9), Money.fromUsd(0.2))).toBe(true);
    expect(policy.wouldBreach(costOf(1.9), Money.fromUsd(0.05))).toBe(false);
  });

  it('never reports negative remaining budget', () => {
    expect(policy.remaining(costOf(5)).usd).toBe(0);
  });
});

describe('SourcePrecedencePolicy', () => {
  const policy = new SourcePrecedencePolicy(['typed_document', 'slides', 'transcript', 'ocr_photo']);
  const chunk = (id: string, kind: 'typed_document' | 'slides' | 'ocr_photo') =>
    ContentChunk.of({ id, text: `text for ${id}`, refs: [SourceRef.whole(id)], kind });

  it('prefers the higher-fidelity source', () => {
    const { winner } = policy.resolve('topic', [chunk('photo', 'ocr_photo'), chunk('doc', 'typed_document')]);
    expect(winner.id).toBe('doc');
  });

  it('merges the losing sources citations rather than discarding them', () => {
    const { winner } = policy.resolve('topic', [chunk('photo', 'ocr_photo'), chunk('doc', 'typed_document')]);
    expect(winner.refs.map((r) => r.sourceId).sort()).toEqual(['doc', 'photo']);
  });

  it('flags the disagreement instead of silently dropping one', () => {
    const { conflict } = policy.resolve('topic', [chunk('photo', 'ocr_photo'), chunk('doc', 'typed_document')]);
    expect(conflict?.discardedChunkIds).toEqual(['photo']);
  });

  it('reports no conflict for a single candidate', () => {
    expect(policy.resolve('topic', [chunk('doc', 'typed_document')]).conflict).toBeUndefined();
  });
});

describe('ScriptScopingPolicy — the FR-9 enforcement rule', () => {
  const policy = new ScriptScopingPolicy();
  const citations = [Citation.of('c1', [SourceRef.page('doc', 1)])];
  const assert_ = (sentence: string, citationIds: string[]) =>
    ({ sentence, kind: 'assert' as const, citationIds });

  it('admits a sentence with a resolvable citation', () => {
    expect(policy.validate([assert_('A claim.', ['c1'])], citations)).toEqual([]);
  });

  it('rejects an uncited sentence', () => {
    const [violation] = policy.validate([assert_('A claim.', [])], citations);
    expect(violation?.reason).toBe('missing_citation');
  });

  it('rejects a citation id that does not exist', () => {
    const [violation] = policy.validate([assert_('A claim.', ['nope'])], citations);
    expect(violation?.reason).toBe('unknown_citation');
  });

  it('rejects a sentence where only some of the citations resolve', () => {
    const [violation] = policy.validate([assert_('A claim.', ['c1', 'nope'])], citations);
    expect(violation?.reason).toBe('unknown_citation');
  });

  /**
   * A teaching sentence — a hook, an analogy, a transition — states nothing
   * about the subject, so there is nothing for it to cite. This is what lets the
   * narration read as an explanation rather than as a compressed paraphrase of
   * the source, which is what it was.
   */
  it('admits a teaching sentence with no citation', () => {
    expect(policy.validate(
      [{ sentence: 'Think of it as one crowd moving back and forth.', kind: 'teach', citationIds: [] }],
      citations,
    )).toEqual([]);
  });

  /**
   * The one way the distinction could be abused: labelling an unsupported claim
   * as teaching. A teaching sentence that cites something is a claim wearing the
   * wrong label, so it is rejected rather than silently accepted.
   */
  it('rejects a teaching sentence that carries a citation', () => {
    const [violation] = policy.validate(
      [{ sentence: 'Lithium ions move between electrodes.', kind: 'teach', citationIds: ['c1'] }],
      citations,
    );
    expect(violation?.reason).toBe('cited_teaching_sentence');
  });

  /**
   * Checked per sentence, not per scene. The stage used to pass one claim per
   * scene with `citationIds[0]` standing in for all of it, so a scene whose
   * second sentence cited nothing passed on the strength of its first.
   */
  it('catches an uncited sentence sitting beside a cited one', () => {
    const violations = policy.validate(
      [assert_('A cited claim.', ['c1']), assert_('An uncited one.', [])],
      citations,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.sentence).toBe('An uncited one.');
  });
});

const explainer = VideoStyle.of({
  name: 'explainer',
  narration: 'Warm and clear, addressed to one learner.',
  visual: 'One idea per board, room to breathe.',
});

describe('PersonalisationPolicy — FR-14 made testable', () => {
  const policy = new PersonalisationPolicy();

  it('produces a neutral brief when nothing was supplied', () => {
    const brief = policy.resolve(StudentContext.empty(), explainer);
    expect(brief.emphasisedTopics).toEqual([]);
    expect(brief.register).toContain('neutral');
  });

  it('gives a master\'s student a different brief than a high-schooler', () => {
    const school = policy.resolve(StudentContext.of({ level: 'high_school' }), explainer);
    const masters = policy.resolve(StudentContext.of({ level: 'master' }), explainer);

    expect(school.register).not.toBe(masters.register);
    expect(school.assumedPriorKnowledge).not.toBe(masters.assumedPriorKnowledge);
  });

  it('lets the goal drive structure', () => {
    const exam = policy.resolve(StudentContext.of({ goal: 'exam preparation' }), explainer);
    const review = policy.resolve(StudentContext.of({ goal: 'quick review' }), explainer);

    expect(exam.structure).toMatch(/formula/i);
    expect(review.structure).toMatch(/compress/i);
    expect(exam.structure).not.toBe(review.structure);
  });

  it('raises time allocation on a declared weakness', () => {
    const context = StudentContext.of({ profile: { weaknesses: ['thermodynamics'] } });
    expect(policy.timeAllocationFor('Thermodynamics basics', context)).toBeGreaterThan(
      policy.timeAllocationFor('Kinematics', context),
    );
  });

  it('degrades gracefully when only some fields are present', () => {
    const brief = policy.resolve(StudentContext.of({ instructions: 'focus on formulas' }), explainer);
    expect(brief.explicitInstructions).toBe('focus on formulas');
    expect(brief.register).toBe(policy.resolve(StudentContext.of({ goal: 'x' }), explainer).register);
  });
});
