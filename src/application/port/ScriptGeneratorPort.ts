import type { DiagramShape } from '@domain/script/DiagramShape.js';
import type { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import type { Language } from '@domain/shared/Language.js';
import type { Duration } from '@domain/shared/Duration.js';
import type { NarrationBrief } from '@domain/script/NarrationScript.js';
import type { Citation } from '@domain/content/Citation.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';
import type { TokenUsage } from './CostMeterPort.js';

/**
 * One narrated sentence.
 *
 * `assert` states something the material says and must cite it. `teach` frames,
 * connects or gives an analogy — it states no fact about the subject, so it has
 * nothing to cite and never reaches `traceability.json`.
 */
export interface GeneratedSentence {
  readonly text: string;
  readonly kind: 'assert' | 'teach';
  readonly citationIds: readonly string[];
}

export interface GeneratedScene {
  readonly index: number;
  readonly sentences: readonly GeneratedSentence[];
  /** Everything the voice says, in order — teaching and assertions alike. */
  readonly narration: string;
  /** Only the sentences that state a source fact. What an audit runs against. */
  readonly sourcedNarration: string;
  readonly citationIds: readonly string[];
  readonly visualIntent: DiagramShape;
  /**
   * True to build on the previous scene's board rather than wiping to a new one.
   *
   * Honoured only when the shapes agree and the scene is not the first — see
   * `groupIntoBoards`, which is where the rule lives.
   */
  readonly continuesBoard?: boolean;
}

export interface ScriptGenerationResult {
  readonly scenes: readonly GeneratedScene[];
  readonly citations: readonly Citation[];
  readonly usage: TokenUsage;
}

export interface ScriptGeneratorPort {
  generate(input: {
    content: ConsolidatedContent;
    outputLanguage: Language;
    targetDuration: Duration;
    wordBudget: number;
    brief: NarrationBrief;
    /**
     * The image libraries this job permits, in preference order.
     *
     * The generator intersects it with what the deployment can actually reach
     * and offers the `illustration` shape only if something survives. A list is
     * carried rather than a boolean because the intersection cannot be taken
     * from one: "the caller allows generated art" and "this deployment only has
     * Unsplash" is an empty intersection that a `true` would hide.
     */
    imageSources: readonly ImageSourceId[];
    /**
     * Objections from the story-plan review, when this is a revision.
     *
     * A second pass at the *same* brief with the critique attached, rather than
     * a separate `revise` method: the inputs are identical, the validation is
     * identical, and a second entry point would be a second place for the two to
     * drift. Empty or absent means this is the first attempt.
     */
    revisionNotes?: readonly string[];
    signal?: AbortSignal;
  }): Promise<ScriptGenerationResult>;
}
