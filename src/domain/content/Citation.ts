import type { SourceRef } from './SourceRef.js';

/**
 * A claim's support. ScriptScopingPolicy admits a narration sentence only if it
 * resolves to one of these — that is the FR-9 enforcement point.
 */
export class Citation {
  private constructor(
    public readonly id: string,
    public readonly refs: readonly SourceRef[],
    public readonly quote: string | undefined,
  ) {}

  public static of(id: string, refs: readonly SourceRef[], quote?: string): Citation {
    if (refs.length === 0) throw new RangeError(`Citation '${id}' must reference at least one source.`);
    return new Citation(id, refs, quote);
  }

  /**
   * Merging never loses a citation: a claim covered by both the slides and the
   * lecture audio cites both, which is what keeps consolidation traceable.
   */
  public mergedWith(other: Citation): Citation {
    const byKey = new Map<string, SourceRef>();
    for (const ref of [...this.refs, ...other.refs]) byKey.set(ref.key, ref);
    return new Citation(this.id, [...byKey.values()], this.quote ?? other.quote);
  }

  public toJSON(): { id: string; refs: ReturnType<SourceRef['toJSON']>[]; quote?: string } {
    return { id: this.id, refs: this.refs.map((r) => r.toJSON()), ...(this.quote ? { quote: this.quote } : {}) };
  }
}
