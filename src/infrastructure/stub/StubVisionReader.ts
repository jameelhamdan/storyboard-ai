import type { VisionReaderPort } from '../extraction/ImageExtractor.js';

/**
 * Returns nothing, so an image-only job hits INSUFFICIENT_CONTENT — which is the
 * truthful outcome until the vision adapter lands at M3.
 */
export class StubVisionReader implements VisionReaderPort {
  public async read(): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number; model: string } }> {
    return { text: '', usage: { inputTokens: 0, outputTokens: 0, model: 'stub' } };
  }
}
