import mammoth from 'mammoth';
import type { ContentExtractorPort, ExtractionInput } from '@application/port/ContentExtractorPort.js';
import { SourceDocument } from '@domain/content/SourceDocument.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';
import type { LanguageDetector } from './LanguageDetector.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Chunks on headings rather than paragraphs: a heading is the author's own
 * statement of where one idea ends and the next begins, which makes it a better
 * citation unit than an arbitrary paragraph split.
 */
export class DocxExtractor implements ContentExtractorPort {
  public readonly name = 'docx';

  constructor(private readonly detector: LanguageDetector) {}

  public supports(mimeType: string): boolean {
    return mimeType === DOCX_MIME;
  }

  public async extract(input: ExtractionInput): Promise<SourceDocument> {
    if (!input.localPath) throw new UnsupportedFormatError('DOCX source has no local file.');

    const { value: html } = await mammoth.convertToHtml({ path: input.localPath });
    const sections = splitOnHeadings(html);

    const chunks = sections
      .filter((s) => s.text.length > 0)
      .map((section, i) => ContentChunk.of({
        id: `${input.sourceId}:s${i}`,
        text: section.text,
        refs: [section.heading
          ? SourceRef.section(input.sourceId, section.heading)
          : SourceRef.whole(input.sourceId)],
        kind: 'typed_document',
        order: i,
      }));

    const detected = this.detector.detect(chunks.map((c) => c.text).join(' ').slice(0, 4000));

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

function splitOnHeadings(html: string): { heading: string | undefined; text: string }[] {
  const sections: { heading: string | undefined; text: string }[] = [];
  let heading: string | undefined;
  let buffer: string[] = [];

  const flush = (): void => {
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (text) sections.push({ heading, text });
    buffer = [];
  };

  const tagPattern = /<(h[1-6]|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    const tag = match[1]!.toLowerCase();
    const text = stripTags(match[2] ?? '');
    if (!text) continue;

    if (tag.startsWith('h')) {
      flush();
      heading = text;
      buffer.push(text);
    } else {
      buffer.push(text);
    }
  }
  flush();

  return sections;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
