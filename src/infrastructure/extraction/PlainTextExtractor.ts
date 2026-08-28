import { readFile } from 'node:fs/promises';
import type { ContentExtractorPort, ExtractionInput } from '@application/port/ContentExtractorPort.js';
import { SourceDocument } from '@domain/content/SourceDocument.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';
import type { LanguageDetector } from './LanguageDetector.js';

/**
 * Plain text and Markdown.
 *
 * Magic-byte sniffing cannot identify text — there is no signature — so this is
 * matched on the declared type instead, which is safe here precisely because
 * text has no executable interpretation: the worst a mislabelled binary can do
 * is produce mojibake that the content thresholds then reject.
 *
 * Chunks split on blank lines, because a paragraph break is the author's own
 * statement of where one idea ends.
 */
export class PlainTextExtractor implements ContentExtractorPort {
  public readonly name = 'text';

  private static readonly TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);

  constructor(private readonly detector: LanguageDetector) {}

  public supports(mimeType: string): boolean {
    return PlainTextExtractor.TYPES.has(mimeType);
  }

  public async extract(input: ExtractionInput): Promise<SourceDocument> {
    if (!input.localPath) throw new UnsupportedFormatError('Text source has no local file.');

    const text = (await readFile(input.localPath, 'utf8')).replace(/\r\n/g, '\n');

    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter((p) => p.length > 0);

    const chunks = paragraphs.map((paragraph, i) => ContentChunk.of({
      id: `${input.sourceId}:p${i}`,
      text: paragraph,
      // Text has no pages; the paragraph index is the finest locator available,
      // and it is what a citation resolves to.
      refs: [SourceRef.section(input.sourceId, `paragraph ${i + 1}`)],
      kind: 'typed_document',
      order: i,
    }));

    const detected = this.detector.detect(text.slice(0, 4000));

    return SourceDocument.of({
      id: input.sourceId,
      origin: input.origin,
      kind: 'typed_document',
      chunks,
      ...(detected ? { detectedLanguage: detected } : {}),
      extractionWarnings: chunks.length === 0 ? ['no-extractable-text'] : [],
    });
  }
}
