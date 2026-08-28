import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { ContentExtractorPort, ExtractionInput } from '@application/port/ContentExtractorPort.js';
import { SourceDocument } from '@domain/content/SourceDocument.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';
import type { LanguageDetector } from './LanguageDetector.js';
import type { TokenUsage } from '@application/port/CostMeterPort.js';

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Reads an image and returns what it says. Vision model, not classical OCR. */
export interface VisionReaderPort {
  read(input: {
    imageBase64: string;
    mimeType: string;
    signal?: AbortSignal;
  }): Promise<{ text: string; usage: TokenUsage }>;
}

/**
 * A vision model rather than Tesseract, because blackboard photos and handwriting
 * are precisely where classical OCR fails — and those are the realistic student
 * uploads. This is also the stage that most justifies spending on the expensive
 * model: a misread formula becomes a wrong fact the pipeline then faithfully cites.
 */
export class ImageExtractor implements ContentExtractorPort {
  public readonly name = 'image';

  constructor(
    private readonly vision: VisionReaderPort,
    private readonly detector: LanguageDetector,
  ) {}

  public supports(mimeType: string): boolean {
    return IMAGE_MIMES.has(mimeType);
  }

  public async extract(input: ExtractionInput): Promise<SourceDocument> {
    if (!input.localPath) throw new UnsupportedFormatError('Image source has no local file.');

    // Downscale before sending: a 12MP phone photo costs vision tokens for
    // resolution the model cannot use.
    const normalised = await sharp(await readFile(input.localPath))
      .rotate()
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();

    const result = await this.vision.read({
      imageBase64: normalised.toString('base64'),
      mimeType: 'image/jpeg',
      ...(input.sniffedMimeType ? {} : {}),
    });

    const text = result.text.trim();
    const detected = this.detector.detect(text);

    return SourceDocument.of({
      id: input.sourceId,
      origin: input.origin,
      kind: 'ocr_photo',
      chunks: text
        ? [ContentChunk.of({
            id: `${input.sourceId}:img`,
            text,
            refs: [SourceRef.whole(input.sourceId)],
            kind: 'ocr_photo',
            ...(detected ? { detectedLanguage: detected } : {}),
            mediaRefs: [input.localPath],
          })]
        : [],
      ...(detected ? { detectedLanguage: detected } : {}),
      extractionWarnings: text ? [] : ['no-extractable-text'],
    });
  }
}
