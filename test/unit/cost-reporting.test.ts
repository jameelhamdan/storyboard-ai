import { describe, it, expect } from 'vitest';
import { loadConfig } from '@interfaces/config/loadConfig.js';
import { testEnv } from '../helpers/env.js';
import { CostBreakdown } from '@domain/cost/CostBreakdown.js';
import { GenerationCost } from '@domain/cost/GenerationCost.js';
import { CostMeter, DEFAULT_PRICING, type ProviderNames } from '@infrastructure/observability/CostMeter.js';
import { Money } from '@domain/shared/Money.js';

const PROVIDERS: ProviderNames = {
  llm: 'openai', tts: 'elevenlabs', stt: 'whisper',
  rendering: 'ffmpeg', storage: 'local', embeddings: 'stub', images: 'none', search: 'none',
};

const entry = (over: Partial<Parameters<CostBreakdown['with']>[0]>) => ({
  stage: 'script', category: 'llm' as const, provider: 'openai',
  amount: Money.fromUsd(1), units: {}, ...over,
});

describe('cost attribution by provider', () => {
  it('groups spend under the vendor that will invoice for it', () => {
    const b = CostBreakdown.empty()
      .with(entry({ provider: 'openai', amount: Money.fromUsd(2) }))
      .with(entry({ provider: 'elevenlabs', category: 'tts', amount: Money.fromUsd(3) }))
      .with(entry({ provider: 'openai', amount: Money.fromUsd(1) }));

    const byProvider = b.byProvider();
    expect(byProvider.map((p) => p.provider)).toEqual(['elevenlabs', 'openai']);
    expect(byProvider.find((p) => p.provider === 'openai')!.amount.usd).toBe(3);
  });

  it('orders most expensive first, since that is why you open the file', () => {
    const b = CostBreakdown.empty()
      .with(entry({ provider: 'cheap', amount: Money.fromUsd(1) }))
      .with(entry({ provider: 'dear', amount: Money.fromUsd(9) }));
    expect(b.byProvider().map((p) => p.provider)).toEqual(['dear', 'cheap']);
  });

  it('sums units and counts calls per provider', () => {
    const b = CostBreakdown.empty()
      .with(entry({ units: { input_tokens: 10, output_tokens: 2 } }))
      .with(entry({ units: { input_tokens: 5, output_tokens: 1 } }));
    const [openai] = b.byProvider();
    expect(openai!.calls).toBe(2);
    expect(openai!.units).toEqual({ input_tokens: 15, output_tokens: 3 });
  });

  it('lists every distinct model a provider was called with', () => {
    const b = CostBreakdown.empty()
      .with(entry({ model: 'gpt-4.1-nano' }))
      .with(entry({ model: 'gpt-4.1-mini' }))
      .with(entry({ model: 'gpt-4.1-nano' }));
    expect(b.byProvider()[0]!.models).toEqual(['gpt-4.1-mini', 'gpt-4.1-nano']);
  });

  it('keeps two providers in the same category apart', () => {
    // The reason byCategory is not enough: "llm" can be served by more than one
    // vendor in a single job, and they bill separately.
    const b = CostBreakdown.empty()
      .with(entry({ provider: 'openai', amount: Money.fromUsd(1) }))
      .with(entry({ provider: 'gemini', amount: Money.fromUsd(4) }));
    expect(b.byProvider().map((p) => [p.provider, p.amount.usd])).toEqual([['gemini', 4], ['openai', 1]]);
    expect(b.byCategory().llm.usd).toBe(5);
  });

  it('reconciles: provider totals sum to the overall total', () => {
    const b = CostBreakdown.empty()
      .with(entry({ provider: 'openai', amount: Money.fromUsd(1.25) }))
      .with(entry({ provider: 'elevenlabs', category: 'tts', amount: Money.fromUsd(2.5) }))
      .with(entry({ provider: 'ffmpeg', category: 'rendering', amount: Money.fromUsd(0.25) }));
    const summed = b.byProvider().reduce((acc, p) => acc + p.amount.usd, 0);
    expect(summed).toBeCloseTo(b.total.usd, 10);
  });
});

describe('cost attribution by stage', () => {
  it('collapses repeated calls from one stage into a single row', () => {
    let b = CostBreakdown.empty();
    for (let i = 0; i < 9; i += 1) {
      b = b.with(entry({ stage: 'storyboard', amount: Money.fromUsd(0.1), units: { input_tokens: 3 } }));
    }
    const rows = b.byStage();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.calls).toBe(9);
    expect(rows[0]!.units['input_tokens']).toBe(27);
    expect(rows[0]!.amount.usd).toBeCloseTo(0.9, 10);
  });

  it('does not merge the same stage across different models', () => {
    const b = CostBreakdown.empty()
      .with(entry({ stage: 'judge', model: 'nano' }))
      .with(entry({ stage: 'judge', model: 'mini' }));
    expect(b.byStage()).toHaveLength(2);
  });
});

describe('the published cost report', () => {
  it('attributes each category to the configured driver', () => {
    const meter = new CostMeter(DEFAULT_PRICING, PROVIDERS);
    meter.recordTokens('script', { inputTokens: 100, outputTokens: 50, model: 'gpt-4o' });
    meter.recordTts('synthesize', 2000);
    meter.recordRender('render', 12);

    const json = meter.snapshot(120).toJSON() as any;
    const providers = Object.fromEntries(json.by_provider.map((p: any) => [p.provider, p]));
    expect(Object.keys(providers).sort()).toEqual(['elevenlabs', 'ffmpeg', 'openai']);
    expect(providers['openai'].models).toEqual(['gpt-4o']);
    expect(providers['elevenlabs'].units.tts_characters).toBe(2000);
  });

  /**
   * A provider without native word timings pays twice: once to synthesize, once
   * to transcribe its own output for the timings. Billing only the first half
   * would make OpenAI TTS look cheaper than ElevenLabs when it is not, and the
   * per-video-minute figure is the number the pricing tier is set from.
   */
  it('bills the alignment pass a recovered-timing provider needs', () => {
    const openaiTts = { ...DEFAULT_PRICING, ttsPerMillionChars: 15.0, ttsAlignmentPerAudioHour: 0.36 };

    const synthesisOnly = new CostMeter(DEFAULT_PRICING, PROVIDERS);
    synthesisOnly.recordTts('synthesize', 1_000_000, 3600);

    const withAlignment = new CostMeter(openaiTts, PROVIDERS);
    withAlignment.recordTts('synthesize', 1_000_000, 3600);

    // A million characters is $15 either way; an hour of alignment adds $0.36.
    expect(synthesisOnly.snapshot(60).total.toUsdRounded(2)).toBe(15);
    expect(withAlignment.snapshot(60).total.toUsdRounded(2)).toBe(15.36);
  });

  it('leaves the alignment unit off a provider that reports its own timings', () => {
    const meter = new CostMeter(DEFAULT_PRICING, PROVIDERS);
    meter.recordTts('synthesize', 2000);

    const json = meter.snapshot(120).toJSON() as any;
    const tts = json.by_provider.find((p: any) => p.provider === 'elevenlabs');
    expect(tts.units.tts_aligned_audio_seconds).toBeUndefined();
  });

  /**
   * The per-video-minute target is the number the pricing tier is set from, so a
   * model swap that quietly breaks it must fail here rather than on an invoice.
   * Token counts are the measured shape of one 3-minute, 8-scene video, and the
   * target is read from config rather than restated — the two drifting apart is
   * exactly the failure this is here to catch.
   */
  it('keeps a representative video under the configured per-video-minute target', () => {
    const meter = new CostMeter(DEFAULT_PRICING, {
      ...PROVIDERS, tts: 'openai',
    });
    const quality = 'gpt-4.1';
    const volume = 'gpt-4.1';

    meter.recordTokens('script', { inputTokens: 3000, outputTokens: 1200, model: quality });
    meter.recordTokens('script', { inputTokens: 1200, outputTokens: 400, model: quality });
    for (let scene = 0; scene < 8; scene += 1) {
      meter.recordTokens('storyboard', { inputTokens: 1800, outputTokens: 2200, model: volume });
      // The scene judge is a vision call and runs on the quality tier — it is
      // the gate on every board, so it is priced here as it is actually billed.
      meter.recordTokens('judgeStoryboard', { inputTokens: 2500, outputTokens: 300, model: quality });
    }
    meter.recordTokens('quiz', { inputTokens: 2000, outputTokens: 600, model: volume });
    meter.recordTts('synthesize', 2600, 180);
    meter.recordRender('render', 240);

    const target = loadConfig(testEnv()).resolved.costTargetPerMinuteUsd;
    const perMinute = meter.snapshot(180).perMinute.usd;

    expect(perMinute).toBeLessThan(target);
    // And with room for retries: a scene that regenerates costs another
    // storyboard call and another judge call, so a config sitting just under
    // the line is one bad scene away from breaching it.
    expect(perMinute).toBeLessThan(target * 0.75);
  });

  it('prices both configured model tiers — an unpriced one silently under-reports', () => {
    // A model missing from the table is recorded as `unpriced_calls` and costs
    // $0, which reads as "cheap" rather than "unknown".
    for (const model of ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-4.1']) {
      expect(DEFAULT_PRICING.llm[model], `${model} is not in the pricing table`).toBeDefined();
    }
  });

  it('records units for an unpriced model rather than reporting a silent zero', () => {
    const meter = new CostMeter(DEFAULT_PRICING, PROVIDERS);
    meter.recordTokens('script', { inputTokens: 1000, outputTokens: 500, model: 'not-in-the-table' });
    const json = meter.snapshot(60).toJSON() as any;
    expect(json.units.unpriced_calls).toBe(1);
    expect(json.units.input_tokens).toBe(1000);
  });

  it('is empty but well-formed for a job that spent nothing', () => {
    const json = GenerationCost.empty().toJSON() as any;
    expect(json.by_provider).toEqual([]);
    expect(json.by_stage).toEqual([]);
    expect(json.total_usd).toBe(0);
  });
});
