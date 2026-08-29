/** Stage weights sum to 100. Render dominates because it does. */
export const STAGE_WEIGHTS = {
  validate: 1,
  /**
   * Off for most jobs, and cheap when on — a search and a page fetch each — but
   * it gets a real slice because it can *add sources*, and a job that spends a
   * minute pulling in six pages should not look stalled at 1%.
   */
  research: 3,
  ingest: 5,
  transcribe: 6,
  consolidate: 5,
  script: 8,
  /**
   * Cheap in wall-clock terms — one model call over text, sometimes two — but
   * it gets its own slice because it can *rewrite the script*, and a stage that
   * can send work backwards should be visible when it does.
   */
  planReview: 3,
  storyboard: 9,
  judgeStoryboard: 8,
  synthesize: 13,
  subtitles: 1,
  quiz: 1,
  render: 28,
  assemble: 5,
  publish: 4,
} as const;

export type StageName = keyof typeof STAGE_WEIGHTS;

/**
 * Every stage that spends money — LLM calls and TTS — runs before `render`.
 *
 * That is deliberate. Render is the one stage measured in tens of minutes and the
 * one most likely to be interrupted, and subtitles and the quiz both need only
 * the *timed* script, which exists as soon as synthesis has measured its audio.
 * Running them earlier means a job resumed after a render interruption re-pays
 * for nothing at all.
 */
export const STAGE_ORDER: readonly StageName[] = [
  'validate', 'research', 'ingest', 'transcribe', 'consolidate', 'script', 'planReview', 'storyboard',
  'judgeStoryboard', 'synthesize', 'subtitles', 'quiz', 'render', 'assemble', 'publish',
];

/**
 * Stages the pipeline can legitimately be assembled without.
 *
 * `research` is only built when the deployment has a search engine *and* a real
 * LLM to plan queries with, and the composition root leaves it out entirely
 * rather than wiring an inert one. The completeness check below did not know
 * that, so it rejected every assembly missing it — which is every credential-free
 * run, the one path the README promises works with no keys at all.
 *
 * Being absent is not the same as being skipped: a stage present but turned off
 * for one job (`planReview` under `features.plan_review: false`) still has to be
 * wired, because another job on the same worker may want it.
 */
export const OPTIONAL_STAGES: ReadonlySet<StageName> = new Set<StageName>(['research']);

export const TOTAL_WEIGHT: number = (Object.values(STAGE_WEIGHTS) as number[])
  .reduce((total, weight) => total + weight, 0);

// The weights are a progress scale; if they stop summing to 100 the reported
// percentage silently stops meaning what the API contract says it means.
if (TOTAL_WEIGHT !== 100) {
  throw new Error(`Stage weights must sum to 100, got ${TOTAL_WEIGHT}.`);
}

/**
 * The single checkpoint document. One file rather than one per stage: every
 * stage's output is a superset of the previous stage's, so per-stage files
 * re-wrote the same script and content on every save.
 */
export const CHECKPOINT_KEY = 'checkpoint.json';
