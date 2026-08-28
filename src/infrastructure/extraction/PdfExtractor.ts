import { readFile } from 'node:fs/promises';
import { extractText, getDocumentProxy } from 'unpdf';
import type { ContentExtractorPort, ExtractionInput } from '@application/port/ContentExtractorPort.js';
import { SourceDocument, type SourceOrigin } from '@domain/content/SourceDocument.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';
import type { LanguageDetector } from './LanguageDetector.js';

/**
 * Apache-licensed pdfjs via unpdf. Both best-in-class PDF engines (PyMuPDF and
 * mupdf.js) are AGPL and would need a commercial licence for proprietary SaaS —
 * this path avoids that entirely, at the cost of weaker extraction on awkward
 * documents, where the vision model picks up the slack.
 */
export class PdfExtractor implements ContentExtractorPort {
  public readonly name = 'pdf';

  constructor(
    private readonly maxPages: number,
    private readonly detector: LanguageDetector,
  ) {}

  public supports(mimeType: string): boolean {
    return mimeType === 'application/pdf';
  }

  public async extract(input: ExtractionInput): Promise<SourceDocument> {
    if (!input.localPath) throw new UnsupportedFormatError('PDF source has no local file.');

    const bytes = new Uint8Array(await readFile(input.localPath));
    const pdf = await getDocumentProxy(bytes);

    if (pdf.numPages > this.maxPages) {
      throw UnsupportedFormatError.overLimit(`page count in '${this.label(input.origin)}'`, pdf.numPages, this.maxPages);
    }

    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];

    const chunks = pages
      .map((pageText, i) => ({ pageText: pageText.trim(), page: i + 1 }))
      .filter((p) => p.pageText.length > 0)
      .map((p) => ContentChunk.of({
        id: `${input.sourceId}:p${p.page}`,
        text: p.pageText,
        refs: [SourceRef.page(input.sourceId, p.page)],
        kind: 'typed_document',
        order: p.page,
      }));

    // A PDF that yields no text is a scan, not an error: it needs the vision path
    // rather than a rejection, so it is flagged for the caller to route.
    const warnings = chunks.length === 0 ? ['no-extractable-text'] : [];
    const detected = this.detector.detect(chunks.map((c) => c.text).join(' ').slice(0, 4000));

    return SourceDocument.of({
      id: input.sourceId,
      origin: input.origin,
      kind: 'typed_document',
      chunks,
      ...(detected ? { detectedLanguage: detected } : {}),
      extractionWarnings: warnings,
    });
  }

  private label(origin: SourceOrigin): string {
    return origin.type === 'file' ? origin.filename : origin.url;
  }
}
