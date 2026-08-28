import type { CostMeterPort, TokenUsage } from '@application/port/CostMeterPort.js';
import type { CostCategory } from '@domain/cost/CostBreakdown.js';
import { CostBreakdown } from '@domain/cost/CostBreakdown.js';
import { GenerationCost } from '@domain/cost/GenerationCost.js';
import { Money } from '@domain/shared/Money.js';

/**
 * Which driver serves each category, so every cost entry can be attributed to
 * the vendor that will invoice for it. Supplied by the composition root because
 * that is the only place that knows which drivers were selected.
 */
export interface ProviderNames {
  readonly llm: string;
  readonly tts: string;
  readonly stt: string;
  readonly rendering: string;
  readonly storage: string;
  readonly embeddings: string;
  /** Whichever model draws generated illustrations, or `none`. */
  readonly images: string;
  /** Whichever engine answers a research query, or `none`. */
  readonly search: string;
}

export interface PricingTable {
  /** USD per million tokens, per model. */
  readonly llm: Readonly<Record<string, { input: number; output: number; cachedInput?: number }>>;
  readonly ttsPerMillionChars: number;
  /**
   * USD per hour of synthesized audio, for providers whose word timings have to
   * be recovered by transcribing their own output. Zero for a synthesiser that
   * reports its own alignment.
   */
  readonly ttsAlignmentPerAudioHour: number;
  readonly sttPerAudioHour: number;
  readonly renderPerCoreHour: number;
  readonly storagePerGbMonth: number;
  /** USD per generated image. Zero for a deployment that only searches. */
  readonly imagePerGeneration: number;
  /**
   * USD per web-search query. Grounded search is billed per *request*, not per
   * token, so it cannot ride along in the model's usage — and research is the
   * one feature that can quietly issue a dozen of them.
   */
  readonly searchPerQuery: number;
}

/**
 * Accumulates per stage. Records counts and money only — never content. Brief §4
 * is explicit that cost logs must not contain student material, and the way to
 * guarantee that is for the meter to have no method that could accept any.
 */
export class CostMeter implements CostMeterPort {
  private breakdown = CostBreakdown.empty();

  constructor(
    private readonly pricing: PricingTable,
    private readonly providers: ProviderNames,
  ) {}

  public recordTokens(stage: string, usage: TokenUsage): void {
    const model = usage.model ?? 'unknown';
    const rates = this.pricing.llm[model];

    // An unpriced model must not silently cost zero — that would make a cost
    // report that reconciles against no invoice. Units are still recorded so the
    // gap is visible in the metadata.
    const amount = rates
      ? Money.fromUsd(
          (usage.inputTokens / 1_000_000) * rates.input +
          (usage.outputTokens / 1_000_000) * rates.output +
          ((usage.cachedInputTokens ?? 0) / 1_000_000) * (rates.cachedInput ?? rates.input),
        )
      : Money.zero();

    this.breakdown = this.breakdown.with({
      stage,
      category: 'llm',
      provider: this.providers.llm,
      model,
      amount,
      units: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cached_input_tokens: usage.cachedInputTokens ?? 0,
        ...(rates ? {} : { unpriced_calls: 1 }),
      },
    });
  }

  /**
   * Synthesis is billed per character; `audioSeconds` additionally bills the
   * alignment pass a provider without native word timings needs. Both land in
   * the same category, because both are what the narration actually costs —
   * splitting them would let a provider look cheap by hiding half its bill.
   */
  public recordTts(stage: string, characters: number, audioSeconds = 0): void {
    const synthesis = (characters / 1_000_000) * this.pricing.ttsPerMillionChars;
    const alignment = (audioSeconds / 3600) * this.pricing.ttsAlignmentPerAudioHour;

    this.breakdown = this.breakdown.with({
      stage,
      category: 'tts',
      provider: this.providers.tts,
      amount: Money.fromUsd(synthesis + alignment),
      units: {
        tts_characters: characters,
        ...(audioSeconds > 0 ? { tts_aligned_audio_seconds: Math.round(audioSeconds) } : {}),
      },
    });
  }

  public recordStt(stage: string, audioSeconds: number): void {
    this.breakdown = this.breakdown.with({
      stage,
      category: 'stt',
      provider: this.providers.stt,
      amount: Money.fromUsd((audioSeconds / 3600) * this.pricing.sttPerAudioHour),
      units: { stt_audio_seconds: Math.round(audioSeconds) },
    });
  }

  public recordRender(stage: string, wallSeconds: number): void {
    this.breakdown = this.breakdown.with({
      stage,
      category: 'rendering',
      provider: this.providers.rendering,
      amount: Money.fromUsd((wallSeconds / 3600) * this.pricing.renderPerCoreHour),
      units: { render_wall_seconds: Math.round(wallSeconds) },
    });
  }

  /**
   * One generated illustration. Billed per image rather than per token, which
   * is why it does not go through `recordTokens`.
   */
  public recordImage(stage: string, count = 1): void {
    this.breakdown = this.breakdown.with({
      stage,
      category: 'images',
      provider: this.providers.images,
      amount: Money.fromUsd(count * this.pricing.imagePerGeneration),
      units: { images_generated: count },
    });
  }

  /** Web-search queries, billed per request rather than per token. */
  public recordSearch(stage: string, queries: number): void {
    this.breakdown = this.breakdown.with({
      stage,
      category: 'search',
      provider: this.providers.search,
      amount: Money.fromUsd(queries * this.pricing.searchPerQuery),
      units: { search_queries: queries },
    });
  }

  public recordStorage(stage: string, bytes: number): void {
    const gbMonths = (bytes / 1024 ** 3) * (1 / 30); // artifacts are short-lived
    this.breakdown = this.breakdown.with({
      stage,
      category: 'storage',
      provider: this.providers.storage,
      amount: Money.fromUsd(gbMonths * this.pricing.storagePerGbMonth),
      units: { stored_bytes: bytes },
    });
  }

  public recordCustom(stage: string, category: CostCategory, amount: Money, units: Record<string, number>): void {
    this.breakdown = this.breakdown.with({
      stage, category, provider: this.providers[category], amount, units,
    });
  }

  public snapshot(videoDurationSeconds: number): GenerationCost {
    return GenerationCost.of(this.breakdown, videoDurationSeconds);
  }
}

/**
 * Estimates pending invoice verification at M1 — every figure here is a guess
 * until a real bill lands, and the §11 totals inherit that uncertainty.
 * Local Whisper and local embeddings are genuinely free, not estimated.
 */
export const DEFAULT_PRICING: PricingTable = {
  llm: {
    // Gemini, read from ai.google.dev/gemini-api/docs/pricing rather than from
    // memory. The ids are the ones the API actually serves — an earlier table
    // priced `gemini-3-flash` and `gemini-3.1-pro`, neither of which exists, so
    // every Gemini call would have been recorded as unpriced.
    //
    // 3.7 Flash is on introductory pricing through 2026-12-31, after which it
    // doubles to 1.50/7.50. That is a date this table has to be revisited on,
    // not a number to average out.
    'gemini-3.7-flash': { input: 0.75, output: 3.75, cachedInput: 0.075 },
    'gemini-3.5-flash': { input: 1.50, output: 9.00, cachedInput: 0.15 },
    'gemini-3-flash-preview': { input: 0.50, output: 3.00, cachedInput: 0.05 },
    // Prompts over 200k tokens are billed at double this. A consolidated source
    // document reaching that size is possible, so the figure is a floor.
    'gemini-3.1-pro-preview': { input: 2.00, output: 12.00, cachedInput: 0.20 },
    // GPT-5 family. Prices read from OpenAI's pricing page, not from memory —
    // several of these post-date this assistant's training data.
    'gpt-5.6-sol': { input: 4.00, output: 20.00, cachedInput: 0.40 },
    'gpt-5.6-terra': { input: 2.00, output: 12.00, cachedInput: 0.20 },
    'gpt-5.6-luna': { input: 0.20, output: 1.20, cachedInput: 0.02 },
    'gpt-5.5': { input: 5.00, output: 30.00, cachedInput: 0.50 },
    'gpt-5.5-pro': { input: 30.00, output: 180.00 },
    'gpt-5.4': { input: 2.50, output: 15.00, cachedInput: 0.25 },
    'gpt-5.4-mini': { input: 0.75, output: 4.50, cachedInput: 0.075 },
    'gpt-5.4-nano': { input: 0.20, output: 1.25, cachedInput: 0.02 },
    'gpt-5.2': { input: 1.75, output: 14.00, cachedInput: 0.175 },
    'gpt-5.1': { input: 1.25, output: 10.00, cachedInput: 0.125 },
    'gpt-5': { input: 1.25, output: 10.00, cachedInput: 0.125 },
    'gpt-5-mini': { input: 0.25, output: 2.00, cachedInput: 0.025 },
    'gpt-5-nano': { input: 0.05, output: 0.40, cachedInput: 0.005 },
    'gpt-4.1': { input: 2.00, output: 8.00, cachedInput: 0.50 },
    'gpt-4.1-nano': { input: 0.10, output: 0.40, cachedInput: 0.025 },
    'gpt-4.1-mini': { input: 0.40, output: 1.60, cachedInput: 0.10 },
    'gpt-4o-mini': { input: 0.15, output: 0.60, cachedInput: 0.075 },
    'gpt-4o': { input: 2.50, output: 10.00, cachedInput: 1.25 },
    stub: { input: 0, output: 0 },
  },
  // ElevenLabs' per-character rate, which is also OpenAI `tts-1`'s published
  // rate. Overridden per driver in the composition root.
  ttsPerMillionChars: 15.0,
  ttsAlignmentPerAudioHour: 0,
  sttPerAudioHour: 0,
  renderPerCoreHour: 0.02,
  storagePerGbMonth: 0.015,
  // gemini-3-pro-image, per generated image. Overridden per driver in the
  // composition root; zero when nothing generates.
  imagePerGeneration: 0.134,
  // Gemini charges grounded prompts per request rather than per query; $35 per
  // thousand is the published rate, and one research round is one request.
  searchPerQuery: 0.035,
};
