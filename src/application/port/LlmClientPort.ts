import type { TokenUsage } from './CostMeterPort.js';

/**
 * Two tiers, which is the cost decision made concrete.
 *
 * `quality` is for calls where being wrong is expensive and hard to detect:
 * reading the student's material, writing the source-locked script, choosing
 * the video's design, and *judging a rendered board from its screenshot*.
 *
 * `volume` is for calls that are numerous, schema-constrained and checked
 * downstream: storyboard markup (validated deterministically, regenerated on
 * failure) and the quiz.
 *
 * The split is by *how hard the judgement is*, not by whose material it is —
 * an earlier version put the judge on `volume` because it grades our own
 * output, which stopped being the right reason once grading meant looking at
 * an image rather than reading markup.
 */
export type ModelTier = 'quality' | 'volume';

export interface GenerateOptions {
  readonly system: string;
  readonly user: string;
  readonly tier: ModelTier;
  /** JSON Schema. When present the model is constrained to it. */
  readonly responseSchema?: Record<string, unknown>;
  readonly images?: readonly { mimeType: string; base64: string }[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export interface GenerateResult<T = string> {
  readonly text: string;
  readonly parsed: T | undefined;
  readonly usage: TokenUsage;
}

/**
 * The whole vendor surface the generation adapters need — two methods.
 *
 * It is a port rather than a concrete client because the five generators
 * (script, storyboard, judge, quiz, vision) are provider-agnostic: they compose
 * a prompt and a schema and read back parsed JSON. Naming a vendor in them
 * would put the choice in five files instead of the composition root.
 */
export interface LlmClientPort {
  modelFor(tier: ModelTier): string;
  generate<T = string>(options: GenerateOptions): Promise<GenerateResult<T>>;
}
