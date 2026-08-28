import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { ContentExtractorPort, ExtractionInput } from '@application/port/ContentExtractorPort.js';
import { SourceDocument, type SourceOrigin } from '@domain/content/SourceDocument.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';
import type { SafeHttpClient } from '../http/SafeHttpClient.js';
import type { LanguageDetector } from './LanguageDetector.js';

/**
 * Readability strips navigation, ads and boilerplate, which matters more here
 * than usual: a page's chrome is the same on every page of a site, so leaving it
 * in would make unrelated sources look like duplicates to the consolidator.
 */
export class WebPageExtractor implements ContentExtractorPort {
  public readonly name = 'web';

  constructor(
    private readonly http: SafeHttpClient,
    private readonly detector: LanguageDetector,
  ) {}

  public supports(_mimeType: string, origin: SourceOrigin): boolean {
    return origin.type === 'url';
  }

  public async extract(input: ExtractionInput): Promise<SourceDocument> {
    if (input.origin.type !== 'url') {
      throw new UnsupportedFormatError('WebPageExtractor was given a non-URL source.');
    }

    const response = await this.http.fetch(input.origin.url);
    // Typed explicitly: the Speech SDK pulls in @types/webrtc, which puts a DOM
    // `Window` in scope and makes the inferred shape of parseHTML's result
    // collide with it.
    const { document } = parseHTML(response.body.toString('utf8')) as unknown as { document: unknown };
    // linkedom's Document is structurally compatible with what Readability needs,
    // but the two packages ship independent DOM typings that do not unify.
    const article = new Readability(document as never).parse();

    const text = (article?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) {
      throw new UnsupportedFormatError(
        `No readable article content was found at '${input.origin.url}'.`,
        { url: input.origin.url },
      );
    }

    const paragraphs = text.split(/(?<=\.)\s+(?=[A-ZÁÉÍÓÚÑ])/).filter((p) => p.length > 80);
    const grouped = groupToTargetLength(paragraphs.length > 0 ? paragraphs : [text], 1200);

    const chunks = grouped.map((body, i) => ContentChunk.of({
      id: `${input.sourceId}:c${i}`,
      text: body,
      refs: [article?.title
        ? SourceRef.section(input.sourceId, article.title)
        : SourceRef.whole(input.sourceId)],
      kind: 'web_page',
      order: i,
    }));

    const detected = this.detector.detect(text.slice(0, 4000));

    return SourceDocument.of({
      id: input.sourceId,
      origin: input.origin,
      kind: 'web_page',
      chunks,
      ...(detected ? { detectedLanguage: detected } : {}),
    });
  }
}

/** Chunks that are too small dilute embeddings; too large blur provenance. */
function groupToTargetLength(parts: readonly string[], target: number): string[] {
  const out: string[] = [];
  let buffer = '';

  for (const part of parts) {
    buffer = buffer ? `${buffer} ${part}` : part;
    if (buffer.length >= target) {
      out.push(buffer);
      buffer = '';
    }
  }
  if (buffer) out.push(buffer);
  return out;
}
