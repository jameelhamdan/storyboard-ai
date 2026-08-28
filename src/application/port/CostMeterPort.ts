import type { Money } from '@domain/shared/Money.js';
import type { CostCategory } from '@domain/cost/CostBreakdown.js';
import type { GenerationCost } from '@domain/cost/GenerationCost.js';

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly model?: string;
}

/**
 * Accumulates per stage. Metadata only — never content. Brief §4 is explicit that
 * cost logs must never contain student material, so this records counts and money,
 * and nothing that could carry a fragment of the source.
 */
export interface CostMeterPort {
  recordTokens(stage: string, usage: TokenUsage): void;
  /** `audioSeconds` bills the alignment pass, for providers that need one. */
  recordTts(stage: string, characters: number, audioSeconds?: number): void;
  recordStt(stage: string, audioSeconds: number): void;
  recordRender(stage: string, wallSeconds: number): void;
  recordStorage(stage: string, bytes: number): void;
  /** One generated illustration — billed per image, not per token. */
  recordImage(stage: string, count?: number): void;
  /** Web-search queries, billed per request rather than per token. */
  recordSearch(stage: string, queries: number): void;
  recordCustom(stage: string, category: CostCategory, amount: Money, units: Record<string, number>): void;

  snapshot(videoDurationSeconds: number): GenerationCost;
}
