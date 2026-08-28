import type { Language } from '../shared/Language.js';
import type { SourceRef } from './SourceRef.js';

export type SourceKind = 'typed_document' | 'slides' | 'transcript' | 'ocr_photo' | 'web_page';

/**
 * The unit consolidation dedupes and citations point at. Provenance travels with
 * the text — there is no separate index to keep in sync.
 */
export class ContentChunk {
  private constructor(
    public readonly id: string,
    public readonly text: string,
    public readonly refs: readonly SourceRef[],
    public readonly kind: SourceKind,
    public readonly detectedLanguage: Language | undefined,
    public readonly mediaRefs: readonly string[],
    public readonly order: number,
  ) {}

  public static of(input: {
    id: string;
    text: string;
    refs: readonly SourceRef[];
    kind: SourceKind;
    detectedLanguage?: Language;
    mediaRefs?: readonly string[];
    order?: number;
  }): ContentChunk {
    const text = input.text.trim();
    if (!text) throw new RangeError(`ContentChunk '${input.id}' has no text.`);
    if (input.refs.length === 0) throw new RangeError(`ContentChunk '${input.id}' has no provenance.`);
    return new ContentChunk(
      input.id, text, input.refs, input.kind,
      input.detectedLanguage, input.mediaRefs ?? [], input.order ?? 0,
    );
  }

  public get wordCount(): number {
    return this.text.split(/\s+/).filter(Boolean).length;
  }

  /** Exact-hash dedupe key for the cheap cases, before embeddings are consulted. */
  public get normalisedText(): string {
    return this.text.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
  }

  /** Union of provenance; the surviving chunk cites every source that contributed. */
  public mergedWith(other: ContentChunk): ContentChunk {
    const byKey = new Map<string, SourceRef>();
    for (const ref of [...this.refs, ...other.refs]) byKey.set(ref.key, ref);
    return new ContentChunk(
      this.id,
      this.text,
      [...byKey.values()],
      this.kind,
      this.detectedLanguage,
      [...new Set([...this.mediaRefs, ...other.mediaRefs])],
      Math.min(this.order, other.order),
    );
  }
}
