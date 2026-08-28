import { readFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import type { ContentExtractorPort, ExtractionInput } from '@application/port/ContentExtractorPort.js';
import { SourceDocument } from '@domain/content/SourceDocument.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';
import type { LanguageDetector } from './LanguageDetector.js';
import type { ArchiveGuard } from './ArchiveGuard.js';
import { readZipEntries } from './ZipReader.js';

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * OOXML is simple enough to parse directly: a PPTX is a zip whose
 * `ppt/slides/slideN.xml` files hold the text in `<a:t>` runs. One chunk per
 * slide, so a citation resolves to a slide number the student can actually find.
 */
export class PptxExtractor implements ContentExtractorPort {
  public readonly name = 'pptx';

  constructor(
    private readonly guard: ArchiveGuard,
    private readonly detector: LanguageDetector,
  ) {}

  public supports(mimeType: string): boolean {
    return mimeType === PPTX_MIME;
  }

  public async extract(input: ExtractionInput): Promise<SourceDocument> {
    if (!input.localPath) throw new UnsupportedFormatError('PPTX source has no local file.');

    const buffer = await readFile(input.localPath);
    const entries = await readZipEntries(buffer);

    this.guard.assertSafe(
      input.origin.type === 'file' ? input.origin.filename : input.sourceId,
      entries.map((e) => ({
        name: e.name,
        compressedSize: e.compressedSize,
        uncompressedSize: e.uncompressedSize,
      })),
    );

    const parser = new XMLParser({ ignoreAttributes: false, textNodeName: '#text' });

    const slides = entries
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .map((e) => ({
        number: Number(e.name.match(/slide(\d+)\.xml$/)?.[1] ?? 0),
        xml: e.read().toString('utf8'),
      }))
      .sort((a, b) => a.number - b.number);

    const chunks = slides
      .map((slide) => ({ number: slide.number, text: collectText(parser.parse(slide.xml)) }))
      .filter((s) => s.text.length > 0)
      .map((s) => ContentChunk.of({
        id: `${input.sourceId}:slide${s.number}`,
        text: s.text,
        refs: [SourceRef.slide(input.sourceId, s.number)],
        kind: 'slides',
        order: s.number,
      }));

    const detected = this.detector.detect(chunks.map((c) => c.text).join(' ').slice(0, 4000));

    return SourceDocument.of({
      id: input.sourceId,
      origin: input.origin,
      kind: 'slides',
      chunks,
      ...(detected ? { detectedLanguage: detected } : {}),
      extractionWarnings: chunks.length === 0 ? ['no-extractable-text'] : [],
    });
  }
}

/** Walks the parsed tree collecting every `a:t` run, in document order. */
function collectText(node: unknown, out: string[] = []): string {
  if (node === null || node === undefined) return out.join(' ').replace(/\s+/g, ' ').trim();

  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
  } else if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
  } else if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.startsWith('@_')) continue;
      collectText(value, out);
    }
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
