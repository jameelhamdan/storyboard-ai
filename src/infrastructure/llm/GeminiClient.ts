import type { TokenUsage } from '@application/port/CostMeterPort.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import type {
  LlmClientPort, ModelTier, GenerateOptions, GenerateResult,
} from '@application/port/LlmClientPort.js';
import { parseJson, withRetry } from './llmResilience.js';
import { toGeminiSchema } from './geminiSchema.js';

export interface GeminiOptions {
  readonly apiKey: string;
  readonly qualityModel: string;
  readonly volumeModel: string;
  readonly maxRetries: number;
  readonly requestTimeoutMs: number;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

interface GenerateContentResponse {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly { readonly text?: string }[] };
    readonly finishReason?: string;
  }[];
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly cachedContentTokenCount?: number;
    readonly thoughtsTokenCount?: number;
  };
  readonly promptFeedback?: { readonly blockReason?: string };
}

/**
 * Google Gemini behind the same port as OpenAI.
 *
 * The two adapters differ only in wire shape, and everything that is a
 * *decision* — retry rules, timeouts, JSON recovery — comes from
 * `llmResilience`, which is why adding this provider did not change any stage.
 *
 * Three differences from the OpenAI adapter are real rather than cosmetic:
 *
 * 1. **The system prompt is its own top-level field**, not a message with a
 *    role. Sending it as a `user` turn works but is weighted differently, and
 *    the prompts in `prompts/` are written as instructions, not as a first turn.
 * 2. **The response schema is OpenAPI, not JSON Schema** — see `geminiSchema`.
 * 3. **Reasoning tokens are billed but not returned.** `thoughtsTokenCount` is
 *    output the invoice charges for and the response does not contain, so it is
 *    added to `outputTokens`; leaving it out made Gemini look 30-40% cheaper
 *    than it is on exactly the calls we use it for. It is not a rounding error:
 *    a two-token answer from 3.5 Flash came back with 184 thought tokens behind
 *    it, so on our calls thinking *is* the bill.
 */
export class GeminiClient implements LlmClientPort {
  private readonly baseUrl: string;

  /**
   * Models that rejected `thinkingConfig`, so it is not sent to them again.
   *
   * Gemini 3 takes `thinkingConfig.thinkingLevel`; Gemini 2.5 takes a
   * `thinkingBudget` instead and 400s on the level. The recovery below handles
   * that correctly but costs a failed round-trip, and this pipeline makes one
   * call per scene — so remembering the first rejection turns one wasted request
   * per *call* into one per process. Per instance rather than module-global: one
   * endpoint's behaviour is not evidence about another's.
   */
  private readonly rejectsThinkingConfig = new Set<string>();

  constructor(
    private readonly options: GeminiOptions,
    private readonly logger: LoggerPort,
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  public modelFor(tier: ModelTier): string {
    return tier === 'quality' ? this.options.qualityModel : this.options.volumeModel;
  }

  public async generate<T = string>(options: GenerateOptions): Promise<GenerateResult<T>> {
    const model = this.modelFor(options.tier);

    const body: Record<string, unknown> = {
      ...(options.system ? { systemInstruction: { parts: [{ text: options.system }] } } : {}),
      contents: [{
        role: 'user',
        parts: [
          { text: options.user },
          ...(options.images ?? []).map((image) => ({
            inlineData: { mimeType: image.mimeType, data: image.base64 },
          })),
        ],
      }],
      generationConfig: {
        // Deterministic by default, for the same reason as the OpenAI adapter:
        // two runs over the same material should differ because the material
        // differs. Gemini accepts an explicit temperature on every model, so
        // there is no rejection path to remember here.
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.maxOutputTokens ?? 8192,
        /**
         * The volume tier thinks less, on purpose.
         *
         * Its calls are schema-constrained and validated downstream — a bad
         * storyboard is a validation failure, not a shipped video — so the
         * deliberation that makes the quality tier worth paying for buys nothing
         * here. Measured on the same trivial prompt, `low` halved the thought
         * tokens (184 → 88), and thoughts are billed as output.
         *
         * The quality tier is left at the model's default: reading a student's
         * material and judging a whole story is exactly the work thinking is
         * for.
         */
        ...(options.tier === 'volume' && !this.rejectsThinkingConfig.has(model)
          ? { thinkingConfig: { thinkingLevel: 'low' } }
          : {}),
        ...(options.responseSchema
          ? {
              responseMimeType: 'application/json',
              responseSchema: toGeminiSchema(options.responseSchema),
            }
          : {}),
      },
    };

    const response = await withRetry({
      model,
      maxRetries: this.options.maxRetries,
      requestTimeoutMs: this.options.requestTimeoutMs,
      logger: this.logger,
      ...(options.signal ? { signal: options.signal } : {}),
    }, () => this.post(model, body, options.signal));

    const candidate = response.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('');

    /**
     * A safety block returns 200 with no candidate at all, which reached
     * `parseJson` as "not valid JSON despite a response schema" — a message that
     * sends you to the schema when the fix is the prompt or the material.
     */
    if (!candidate && response.promptFeedback?.blockReason) {
      throw new Error(
        `${model} refused the request: ${response.promptFeedback.blockReason}. ` +
        'The prompt or the source material tripped a safety filter.',
      );
    }

    // Same reasoning as the OpenAI adapter: truncation is a budget problem, and
    // saying so beats letting it surface as malformed JSON.
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw new Error(
        `${model} hit its output ceiling of ` +
        `${(body['generationConfig'] as { maxOutputTokens: number }).maxOutputTokens} tokens ` +
        'and returned a truncated response. Raise maxOutputTokens for this call.',
      );
    }

    const meta = response.usageMetadata;
    const usage: TokenUsage = {
      inputTokens: meta?.promptTokenCount ?? 0,
      outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
      ...(meta?.cachedContentTokenCount
        ? { cachedInputTokens: meta.cachedContentTokenCount }
        : {}),
      model,
    };

    return {
      text,
      parsed: options.responseSchema ? parseJson<T>(text, model) : undefined,
      usage,
    };
  }

  private async post(
    model: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GenerateContentResponse> {
    // The key goes in a header, never in the query string: a URL is logged by
    // every proxy in the path and the query string is the part that gets logged.
    const send = async (payload: Record<string, unknown>): Promise<Response> => fetch(
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': this.options.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      },
    );

    let response = await send(body);

    // A model from an older generation rejects `thinkingLevel` outright. That is
    // not retryable in general, but dropping the field and trying once more
    // turns a hard failure into a working call — and thinking at the model's
    // default is a cost decision, never a correctness one.
    if (response.status === 400) {
      const detail = await safeBody(response);
      const config = (body['generationConfig'] ?? {}) as Record<string, unknown>;
      if ('thinkingConfig' in config && /thinking/i.test(detail)) {
        this.logger.warn(
          { model },
          'model rejected thinkingConfig; retrying at its default and not sending it again',
        );
        this.rejectsThinkingConfig.add(model);
        const rest = { ...config };
        delete rest['thinkingConfig'];
        response = await send({ ...body, generationConfig: rest });
      } else {
        throw asStatusError(400, detail, response.headers);
      }
    }

    if (!response.ok) {
      throw asStatusError(response.status, await safeBody(response), response.headers);
    }
    return (await response.json()) as GenerateContentResponse;
  }
}

/**
 * Carries `status` and `retryAfterMs` for the same reason the OpenAI adapter
 * does — `isRetryable` needs to tell a 429 from a 400, and a quota error knows
 * its own reset better than exponential backoff can guess it.
 */
function asStatusError(status: number, detail: string, headers?: Headers): Error {
  const error = new Error(`Gemini request failed: ${status} ${detail}`);
  Object.assign(error, { status, retryAfterMs: retryAfterMs(detail, headers) });
  return error;
}

/**
 * Gemini states a quota reset inside the error body as a protobuf `RetryInfo`
 * duration — `"retryDelay": "27s"` — rather than in a header, so the body is the
 * authoritative source here where for OpenAI it is the fallback.
 */
function retryAfterMs(detail: string, headers?: Headers): number | undefined {
  const stated = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(detail);
  if (stated) {
    const seconds = Number(stated[1]);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }

  const header = headers?.get('retry-after');
  if (header) {
    const asMs = Number(header) * 1000;
    if (Number.isFinite(asMs) && asMs > 0) return asMs;
  }
  return undefined;
}

async function safeBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '<unreadable>';
  }
}
