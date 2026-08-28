import type { Language } from '../shared/Language.js';
import type { ContentChunk } from './ContentChunk.js';
import type { SourceKind } from './ContentChunk.js';

export type SourceOrigin =
  | { readonly type: 'file'; readonly filename: string; readonly mimeType: string; readonly bytes: number }
  | { readonly type: 'url'; readonly url: string }
  | { readonly type: 'youtube'; readonly url: string; readonly videoId: string };

/** One ingested input with its detected language and extraction result. */
export class SourceDocument {
  private constructor(
    public readonly id: string,
    public readonly origin: SourceOrigin,
    public readonly kind: SourceKind,
    public readonly chunks: readonly ContentChunk[],
    public readonly detectedLanguage: Language | undefined,
    public readonly extractionWarnings: readonly string[],
  ) {}

  public static of(input: {
    id: string;
    origin: SourceOrigin;
    kind: SourceKind;
    chunks: readonly ContentChunk[];
    detectedLanguage?: Language;
    extractionWarnings?: readonly string[];
  }): SourceDocument {
    return new SourceDocument(
      input.id, input.origin, input.kind, input.chunks,
      input.detectedLanguage, input.extractionWarnings ?? [],
    );
  }

  public get wordCount(): number {
    return this.chunks.reduce((total, c) => total + c.wordCount, 0);
  }

  public get label(): string {
    switch (this.origin.type) {
      case 'file': return this.origin.filename;
      case 'url': return this.origin.url;
      case 'youtube': return this.origin.url;
    }
  }
}
