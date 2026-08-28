/**
 * Where a piece of content came from. Carried end-to-end so FR-13 traceability is
 * a property of the data rather than something reconstructed at the end.
 */
export type SourceLocator =
  | { readonly kind: 'page'; readonly page: number }
  | { readonly kind: 'slide'; readonly slide: number }
  | { readonly kind: 'timestamp'; readonly seconds: number }
  | { readonly kind: 'section'; readonly heading: string }
  | { readonly kind: 'whole' };

export class SourceRef {
  private constructor(
    public readonly sourceId: string,
    public readonly locator: SourceLocator,
  ) {}

  public static page(sourceId: string, page: number): SourceRef {
    return new SourceRef(sourceId, { kind: 'page', page });
  }

  public static slide(sourceId: string, slide: number): SourceRef {
    return new SourceRef(sourceId, { kind: 'slide', slide });
  }

  public static timestamp(sourceId: string, seconds: number): SourceRef {
    return new SourceRef(sourceId, { kind: 'timestamp', seconds });
  }

  public static section(sourceId: string, heading: string): SourceRef {
    return new SourceRef(sourceId, { kind: 'section', heading });
  }

  public static whole(sourceId: string): SourceRef {
    return new SourceRef(sourceId, { kind: 'whole' });
  }

  /** Stable identity so merged chunks can dedupe their citation lists. */
  public get key(): string {
    const l = this.locator;
    switch (l.kind) {
      case 'page': return `${this.sourceId}#p${l.page}`;
      case 'slide': return `${this.sourceId}#s${l.slide}`;
      case 'timestamp': return `${this.sourceId}#t${Math.round(l.seconds)}`;
      case 'section': return `${this.sourceId}#h${l.heading}`;
      case 'whole': return this.sourceId;
    }
  }

  public toJSON(): { source_id: string; locator: SourceLocator } {
    return { source_id: this.sourceId, locator: this.locator };
  }
}
