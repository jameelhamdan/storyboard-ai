import type { VisionReaderPort } from '../extraction/ImageExtractor.js';
import type { TokenUsage } from '@application/port/CostMeterPort.js';
import type { LlmClientPort } from '@application/port/LlmClientPort.js';
import type { PromptLibrary } from './PromptLibrary.js';
import { visionSchema } from './schemas.js';

interface VisionResponse { text: string }

/**
 * Quality tier, deliberately. This reads the student's own material — a
 * blackboard photo, a scanned page, a handwritten derivation — and a misread
 * formula becomes a wrong fact that the pipeline then faithfully cites.
 * Source-lock guarantees traceability, not that the source was read correctly.
 */
export class PromptedVisionReader implements VisionReaderPort {
  constructor(
    private readonly client: LlmClientPort,
    private readonly prompts: PromptLibrary,
  ) {}

  public async read(input: {
    imageBase64: string;
    mimeType: string;
    signal?: AbortSignal;
  }): Promise<{ text: string; usage: TokenUsage }> {
    const prompt = this.prompts.render('05-image-reading');

    const result = await this.client.generate<VisionResponse>({
      system: prompt.system,
      user: prompt.user || 'Transcribe everything legible in this image.',
      tier: 'quality',
      responseSchema: visionSchema as unknown as Record<string, unknown>,
      images: [{ mimeType: input.mimeType, base64: input.imageBase64 }],
      ...(input.signal ? { signal: input.signal } : {}),
    });

    return { text: result.parsed?.text ?? '', usage: result.usage };
  }
}
