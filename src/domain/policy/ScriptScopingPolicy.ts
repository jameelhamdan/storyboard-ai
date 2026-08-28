import type { Citation } from '../content/Citation.js';
import type { ConsolidatedContent } from '../content/ConsolidatedContent.js';

export interface SentenceClaim {
  readonly sentence: string;
  readonly kind: 'assert' | 'teach';
  readonly citationIds: readonly string[];
}

export interface ScopingViolation {
  readonly sentence: string;
  readonly reason: 'missing_citation' | 'unknown_citation' | 'cited_teaching_sentence';
}

/**
 * Whether a script sentence is admissible.
 *
 * An `assert` sentence states something the material says and must resolve to a
 * citation that exists. This is the FR-9 enforcement rule in its deterministic
 * half — the cheap, free check that a citation *exists and points somewhere
 * real*. It cannot tell you whether the cited chunk actually supports the claim;
 * that needs a model.
 *
 * A `teach` sentence states no fact about the subject — it frames, connects or
 * gives an analogy — so it has nothing to cite and is not checked for citations.
 * It is instead checked for *carrying* one, because a teaching sentence with a
 * citation is a claim wearing the wrong label, and that is the only way this
 * distinction could be used to smuggle an unsupported fact past the gate.
 *
 * Note this now runs **per sentence**. It used to be handed one claim per scene,
 * with `citationIds[0]` standing in for the whole thing, so a scene whose second
 * sentence cited nothing passed as long as its first did. The prompt always
 * described the stricter rule; the code now matches it.
 */
export class ScriptScopingPolicy {
  public validate(
    claims: readonly SentenceClaim[],
    citations: readonly Citation[],
  ): ScopingViolation[] {
    const known = new Set(citations.map((c) => c.id));
    const violations: ScopingViolation[] = [];

    for (const claim of claims) {
      if (claim.kind === 'teach') {
        if (claim.citationIds.length > 0) {
          violations.push({ sentence: claim.sentence, reason: 'cited_teaching_sentence' });
        }
        continue;
      }

      if (claim.citationIds.length === 0) {
        violations.push({ sentence: claim.sentence, reason: 'missing_citation' });
      } else if (claim.citationIds.some((id) => !known.has(id))) {
        violations.push({ sentence: claim.sentence, reason: 'unknown_citation' });
      }
    }
    return violations;
  }

  /** Citations must resolve to chunks that survived consolidation. */
  public citationsResolve(citations: readonly Citation[], content: ConsolidatedContent): boolean {
    const chunkIds = new Set(content.chunks.map((c) => c.id));
    const sourceIds = new Set(content.chunks.flatMap((c) => c.refs.map((r) => r.sourceId)));
    return citations.every((c) => c.refs.some((r) => chunkIds.has(r.sourceId) || sourceIds.has(r.sourceId)));
  }
}
