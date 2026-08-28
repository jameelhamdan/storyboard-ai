import type { TokenUsage } from '@application/port/CostMeterPort.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import type {
  LlmClientPort, ModelTier, GenerateOptions, GenerateResult,
} from '@application/port/LlmClientPort.js';
import { parseJson, withRetry } from './llmResilience.js';

export interface OpenAiOptions {
  readonly apiKey: string;
  readonly qualityModel: string;
  readonly volumeModel: string;
  readonly maxRetries: number;
  readonly requestTimeoutMs: number;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com';

interface ChatCompletion {
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null };
    readonly finish_reason?: string;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  };
}

/**
 * OpenAI chat completions — the only real LlmClientPort adapter.
 *
 * Plain `fetch` rather than the vendor SDK: this uses one endpoint with one
 * auth header, and the SDK would add a dependency whose surface dwarfs the part
 * we use. Retry, timeout and JSON recovery come from `llmResilience`, which is
 * separate so a second provider adapter inherits the same rules.
 *
 * Note on residency: this is a US endpoint. plan.md §5 originally required EU
 * processing; that was relaxed to "US or EU" for this project, and the Vertex
 * driver that existed to pin the region was removed. Restoring EU pinning would
 * mean bringing a region-pinnable provider back behind `LlmClientPort`.
 */
export class OpenAiClient implements LlmClientPort {
  private readonly baseUrl: string;

  /**
   * Models known to reject an explicit temperature.
   *
   * The GPT-5 family accepts only the default. The recovery below handles that
   * correctly, but it costs a failed round-trip — and a pipeline makes one LLM
   * call per scene plus one per judge, so *every* call would 400 before
   * succeeding. Remembering the first rejection turns that into one wasted
   * request per process instead of one per call.
   *
   * Per instance rather than module-global: a process could hold clients for
   * different endpoints, and one endpoint's behaviour is not evidence about
   * another's.
   */
  private readonly rejectsTemperature = new Set<string>();

  constructor(
    private readonly options: OpenAiOptions,
    private readonly logger: LoggerPort,
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  public modelFor(tier: ModelTier): string {
    return tier === 'quality' ? this.options.qualityModel : this.options.volumeModel;
  }

  public async generate<T = string>(options: GenerateOptions): Promise<GenerateResult<T>> {
    const model = this.modelFor(options.tier);

    // A bare string when there is no image keeps the request in the shape every
    // model accepts; the parts array is only needed for vision.
    const content = (options.images ?? []).length === 0
      ? options.user
      : [
          { type: 'text', text: options.user },
          ...(options.images ?? []).map((image) => ({
            type: 'image_url',
            image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
          })),
        ];

    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(options.system ? [{ role: 'system', content: options.system }] : []),
        { role: 'user', content },
      ],
      // Deterministic by default: two runs over the same material should differ
      // because the material differs, not because sampling did. Omitted entirely
      // for models we have already seen reject it.
      ...(this.rejectsTemperature.has(model)
        ? {}
        : { temperature: options.temperature ?? 0.2 }),
      // Not `max_tokens`: that is rejected outright by the reasoning models.
      max_completion_tokens: options.maxOutputTokens ?? 8192,
      ...(options.responseSchema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'response',
                schema: options.responseSchema,
                // Not strict: strict mode additionally demands every property be
                // required and additionalProperties be false everywhere, which
                // the shared prompt schemas do not guarantee. Non-strict still
                // constrains the shape; parseJson covers the remainder.
                strict: false,
              },
            },
          }
        : {}),
    };

    const response = await withRetry({
      model,
      maxRetries: this.options.maxRetries,
      requestTimeoutMs: this.options.requestTimeoutMs,
      logger: this.logger,
      ...(options.signal ? { signal: options.signal } : {}),
    }, () => this.post(body, options.signal));

    const text = response.choices?.[0]?.message?.content ?? '';

    /**
     * A response cut off at the token ceiling is truncated, not malformed.
     *
     * Without this the failure surfaced from `parseJson` as "not valid JSON
     * despite a response schema", which sends you looking at the schema and the
     * prompt when the actual fix is a larger budget.
     */
    if (response.choices?.[0]?.finish_reason === 'length') {
      throw new Error(
        `${model} hit its output ceiling of ${body['max_completion_tokens'] as number} tokens ` +
        `and returned a truncated response. Raise maxOutputTokens for this call.`,
      );
    }
    const usage: TokenUsage = {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      ...(response.usage?.prompt_tokens_details?.cached_tokens
        ? { cachedInputTokens: response.usage.prompt_tokens_details.cached_tokens }
        : {}),
      model,
    };

    return {
      text,
      parsed: options.responseSchema ? parseJson<T>(text, model) : undefined,
      usage,
    };
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<ChatCompletion> {
    const send = async (payload: Record<string, unknown>): Promise<Response> =>
      fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      });

    let response = await send(body);

    // Reasoning models accept only the default temperature and reject anything
    // else with a 400. That is not retryable in general, but dropping the field
    // and trying once more turns a hard failure into a working call — and the
    // determinism we wanted from a low temperature is what those models do by
    // default anyway.
    if (response.status === 400 && 'temperature' in body) {
      const detail = await safeBody(response);
      if (/temperature/i.test(detail)) {
        const model = String(body['model']);
        this.logger.warn(
          { model },
          'model rejected an explicit temperature; retrying with the default and not sending it again',
        );
        this.rejectsTemperature.add(model);
        const rest = { ...body };
        delete rest['temperature'];
        response = await send(rest);
      } else {
        throw asStatusError(response.status, detail, response.headers);
      }
    }

    if (!response.ok) throw asStatusError(response.status, await safeBody(response), response.headers);
    return (await response.json()) as ChatCompletion;
  }
}

/**
 * Carries `status` so `isRetryable` can tell a 429 from a 400, and `retryAfterMs`
 * so the backoff can use the provider's own answer instead of guessing.
 *
 * A rate limit is the one failure where the server knows exactly how long to
 * wait, and guessing is measurably worse: exponential backoff from one second
 * gives up after ~7s, while a token-per-minute limit resets over a *minute*. A
 * job saturating its own TPM budget therefore failed outright, which is what
 * happened the first time this pipeline judged scenes concurrently.
 */
function asStatusError(status: number, detail: string, headers?: Headers): Error {
  const error = new Error(`OpenAI request failed: ${status} ${detail}`);
  Object.assign(error, { status, retryAfterMs: retryAfterMs(detail, headers) });
  return error;
}

function retryAfterMs(detail: string, headers?: Headers): number | undefined {
  // The header is authoritative when present; OpenAI sends it in seconds or as
  // a duration like "2.638s" depending on the endpoint.
  const header = headers?.get('retry-after-ms') ?? headers?.get('retry-after');
  if (header) {
    const asMs = headers?.get('retry-after-ms') ? Number(header) : Number(header) * 1000;
    if (Number.isFinite(asMs) && asMs > 0) return asMs;
  }

  // Otherwise the body says it in prose: "Please try again in 2.638s."
  const stated = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(detail);
  if (stated) {
    const value = Number(stated[1]);
    if (Number.isFinite(value)) return stated[2]?.toLowerCase() === 'ms' ? value : value * 1000;
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
