import type { ImageGeneratorPort, GeneratedImage } from '@application/port/ImageGeneratorPort.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';

export interface GeminiImageOptions {
  readonly apiKey: string;
  /** An image-capable model, e.g. `gemini-3-pro-image`. */
  readonly model: string;
  readonly requestTimeoutMs: number;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

interface ImageResponse {
  readonly candidates?: readonly {
    readonly content?: {
      readonly parts?: readonly {
        readonly inlineData?: { readonly mimeType?: string; readonly data?: string };
      }[];
    };
    readonly finishReason?: string;
  }[];
  readonly promptFeedback?: { readonly blockReason?: string };
}

/**
 * Gemini's image model, on the same key as the text models.
 *
 * Same endpoint and the same auth header as `GeminiClient`, but a separate
 * adapter rather than a method on it: this returns bytes, is billed per image
 * rather than per token, and has no schema, no tiers and no retry semantics in
 * common with a text call. Folding it in would give `LlmClientPort` a method
 * that five of its six callers cannot use.
 *
 * A reference image is sent as an ordinary inline part alongside the prompt —
 * the model reads it as "redraw this", which is the whole reason the reference
 * exists. See `ImageGeneratorPort`.
 */
export class GeminiImageGenerator implements ImageGeneratorPort {
  private readonly baseUrl: string;

  constructor(
    private readonly options: GeminiImageOptions,
    private readonly logger: LoggerPort,
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  public get model(): string {
    return this.options.model;
  }

  public async generate(input: {
    prompt: string;
    reference?: GeneratedImage;
    signal?: AbortSignal;
  }): Promise<GeneratedImage> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);

    const response = await fetch(
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.options.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': this.options.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: input.prompt },
              ...(input.reference
                ? [{
                    inlineData: {
                      mimeType: input.reference.mimeType,
                      data: input.reference.bytes.toString('base64'),
                    },
                  }]
                : []),
            ],
          }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
        signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable>');
      throw new Error(`Gemini image request failed: ${response.status} ${detail.slice(0, 300)}`);
    }

    const body = (await response.json()) as ImageResponse;
    const image = body.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;

    if (!image?.data) {
      /**
       * A refusal is a 200 with no image part. Saying so plainly matters more
       * here than elsewhere: the caller's fallback is to ship the reference
       * photograph instead, and "the model declined" and "the request was
       * malformed" call for very different responses from whoever reads the log.
       */
      const reason = body.promptFeedback?.blockReason ?? body.candidates?.[0]?.finishReason;
      this.logger.warn({ model: this.options.model, reason }, 'image model returned no image');
      throw new Error(
        `${this.options.model} returned no image${reason ? `: ${reason}` : ''}.`,
      );
    }

    return {
      bytes: Buffer.from(image.data, 'base64'),
      mimeType: image.mimeType ?? 'image/png',
    };
  }
}
