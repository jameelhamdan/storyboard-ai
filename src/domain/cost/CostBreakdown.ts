import { Money } from '../shared/Money.js';

/** Metadata only, never content: a cost record may not carry student material. */
/**
 * `search` is its own line rather than part of `llm`: a grounded search is
 * billed per *request*, not per token, and research is the one feature that can
 * quietly issue a dozen of them. Images have no line at all — every picture on a
 * board is either drawn by the renderer or found in a library that charges
 * nothing for it.
 */
export type CostCategory =
  | 'llm' | 'tts' | 'stt' | 'rendering' | 'storage' | 'embeddings' | 'search';

export interface CostEntry {
  readonly stage: string;
  readonly category: CostCategory;
  /** The driver that did the work — `openai`, `elevenlabs`, `whisper`, `stub`. */
  readonly provider: string;
  /** Only meaningful for LLM entries, where the tier picks the model. */
  readonly model?: string;
  readonly amount: Money;
  readonly units: Readonly<Record<string, number>>;
}

/** One stage's share of the bill, collapsed across repeated calls. */
export interface StageTotal {
  readonly stage: string;
  readonly category: CostCategory;
  readonly provider: string;
  readonly model?: string;
  readonly amount: Money;
  readonly calls: number;
  readonly units: Readonly<Record<string, number>>;
}

/** One provider's share of the bill, with the units that produced it. */
export interface ProviderTotal {
  readonly provider: string;
  readonly amount: Money;
  readonly categories: readonly CostCategory[];
  readonly models: readonly string[];
  readonly calls: number;
  readonly units: Readonly<Record<string, number>>;
}

export class CostBreakdown {
  private constructor(public readonly entries: readonly CostEntry[]) {}

  public static empty(): CostBreakdown {
    return new CostBreakdown([]);
  }

  public with(entry: CostEntry): CostBreakdown {
    return new CostBreakdown([...this.entries, entry]);
  }

  public get total(): Money {
    return Money.sum(this.entries.map((e) => e.amount));
  }

  public byCategory(): Readonly<Record<CostCategory, Money>> {
    const out: Record<CostCategory, Money> = {
      llm: Money.zero(), tts: Money.zero(), stt: Money.zero(),
      rendering: Money.zero(), storage: Money.zero(), embeddings: Money.zero(),
      search: Money.zero(),
    };
    for (const e of this.entries) out[e.category] = out[e.category].plus(e.amount);
    return out;
  }

  /**
   * The bill split by who we pay, which is the view that reconciles against an
   * invoice. `byCategory` answers "what did we spend it on"; this answers "who
   * is going to charge us for it", and those are different questions once more
   * than one vendor serves the same category.
   */
  public byProvider(): readonly ProviderTotal[] {
    const grouped = new Map<string, {
      amount: Money; categories: Set<CostCategory>; models: Set<string>;
      calls: number; units: Record<string, number>;
    }>();

    for (const e of this.entries) {
      const acc = grouped.get(e.provider) ?? {
        amount: Money.zero(), categories: new Set<CostCategory>(),
        models: new Set<string>(), calls: 0, units: {},
      };
      acc.amount = acc.amount.plus(e.amount);
      acc.categories.add(e.category);
      if (e.model) acc.models.add(e.model);
      acc.calls += 1;
      for (const [k, v] of Object.entries(e.units)) acc.units[k] = (acc.units[k] ?? 0) + v;
      grouped.set(e.provider, acc);
    }

    return [...grouped.entries()]
      .map(([provider, a]) => ({
        provider,
        amount: a.amount,
        categories: [...a.categories].sort(),
        models: [...a.models].sort(),
        calls: a.calls,
        units: a.units,
      }))
      // Most expensive first: the reason to read this file is usually to find
      // out what is costing the most.
      .sort((x, y) => y.amount.usd - x.amount.usd || x.provider.localeCompare(y.provider));
  }

  /**
   * One row per stage/model rather than per call. A scene-level stage makes one
   * call per scene, so the raw entries repeat identically dozens of times and
   * bury the shape of the bill in its own detail.
   */
  public byStage(): readonly StageTotal[] {
    const grouped = new Map<string, {
      stage: string; category: CostCategory; provider: string; model?: string;
      amount: Money; calls: number; units: Record<string, number>;
    }>();

    for (const e of this.entries) {
      const key = `${e.stage}|${e.category}|${e.provider}|${e.model ?? ''}`;
      const acc = grouped.get(key) ?? {
        stage: e.stage, category: e.category, provider: e.provider,
        ...(e.model ? { model: e.model } : {}),
        amount: Money.zero(), calls: 0, units: {},
      };
      acc.amount = acc.amount.plus(e.amount);
      acc.calls += 1;
      for (const [k, v] of Object.entries(e.units)) acc.units[k] = (acc.units[k] ?? 0) + v;
      grouped.set(key, acc);
    }
    return [...grouped.values()];
  }

  /** Aggregated consumption units — tokens, TTS characters, audio seconds. */
  public totalUnits(): Readonly<Record<string, number>> {
    const units: Record<string, number> = {};
    for (const e of this.entries) {
      for (const [k, v] of Object.entries(e.units)) units[k] = (units[k] ?? 0) + v;
    }
    return units;
  }
}
