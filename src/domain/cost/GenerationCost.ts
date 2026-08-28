import type { Money } from '../shared/Money.js';
import { CostBreakdown } from './CostBreakdown.js';

/** Immutable per-stage breakdown; sums to the API's `cost` object. */
export class GenerationCost {
  private constructor(
    public readonly breakdown: CostBreakdown,
    public readonly videoDurationSeconds: number,
  ) {}

  public static of(breakdown: CostBreakdown, videoDurationSeconds: number): GenerationCost {
    return new GenerationCost(breakdown, videoDurationSeconds);
  }

  public static empty(): GenerationCost {
    return new GenerationCost(CostBreakdown.empty(), 0);
  }

  public get total(): Money {
    return this.breakdown.total;
  }

  /** The number the configured per-video-minute target is measured against. */
  public get perMinute(): Money {
    return this.total.perMinute(this.videoDurationSeconds);
  }

  public toJSON(): Record<string, unknown> {
    const byCategory = this.breakdown.byCategory();
    return {
      total_usd: this.total.toUsdRounded(),
      per_minute_usd: this.perMinute.toUsdRounded(),
      breakdown: {
        llm_usd: byCategory.llm.toUsdRounded(),
        tts_usd: byCategory.tts.toUsdRounded(),
        stt_usd: byCategory.stt.toUsdRounded(),
        rendering_usd: byCategory.rendering.toUsdRounded(),
        storage_usd: byCategory.storage.toUsdRounded(),
        embeddings_usd: byCategory.embeddings.toUsdRounded(),
      },
      units: this.breakdown.totalUnits(),
      by_provider: this.breakdown.byProvider().map((p) => ({
        provider: p.provider,
        cost_usd: p.amount.toUsdRounded(),
        categories: p.categories,
        ...(p.models.length > 0 ? { models: p.models } : {}),
        calls: p.calls,
        units: p.units,
      })),
      by_stage: this.breakdown.byStage().map((e) => ({
        stage: e.stage,
        category: e.category,
        provider: e.provider,
        ...(e.model ? { model: e.model } : {}),
        calls: e.calls,
        cost_usd: e.amount.toUsdRounded(),
        units: e.units,
      })),
    };
  }
}
