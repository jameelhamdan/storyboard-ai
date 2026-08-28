import type { NarrationBrief } from '../script/NarrationScript.js';
import type { StudentContext, StudentLevel } from '../shared/StudentContext.js';
import type { VideoStyle, ExtraDirection } from '../media/VideoStyle.js';

/**
 * Everything the caller said about *this* video -> one narration brief (FR-14).
 *
 * Three inputs, and the order matters when they disagree:
 *
 *   1. `StudentContext` — who is watching. Sets register and assumed knowledge.
 *   2. `VideoStyle` — what kind of video this is. Sets delivery and pacing.
 *   3. `ExtraDirection` — the caller's free text for this one video. Last word
 *      on anything the first two did not settle.
 *
 * Applied here and only here. The output is an explicit `NarrationBrief` recorded
 * in job metadata, which is what makes "a master's student gets a different video"
 * *testable* rather than asserted: the test compares two briefs, not two videos.
 *
 * Every field is optional and every missing field degrades to a neutral default,
 * so the pipeline never depends on personalisation being present.
 */

/**
 * Note `primary` asks for analogies. That used to contradict the script prompt,
 * which forbade stating anything the source did not — an analogy compares the
 * subject to something outside the material, so it was never admissible and the
 * register was quietly unsatisfiable. It is satisfiable now: an analogy is a
 * `teach` sentence, capped at one per scene and excluded from the claim set.
 */
const REGISTER: Readonly<Record<StudentLevel, string>> = Object.freeze({
  primary: 'Simple, concrete language. Short sentences. Everyday analogies before terminology.',
  secondary: 'Plain language with terminology introduced and defined as it appears.',
  high_school: 'Clear explanatory prose. Terminology used freely once defined. Worked examples over abstraction.',
  bachelor: 'Standard academic register. Assumes core terminology in the field is familiar.',
  master: 'Concise technical register. Assumes fluency; spends its words on nuance and edge cases rather than definitions.',
  doctorate: 'Peer-level register. Compresses established material and dwells on what is contested or non-obvious.',
});

const PRIOR_KNOWLEDGE: Readonly<Record<StudentLevel, string>> = Object.freeze({
  primary: 'Assume no prior exposure to the topic.',
  secondary: 'Assume general schooling but no subject-specific background.',
  high_school: 'Assume the prerequisites named in the source, nothing beyond them.',
  bachelor: 'Assume first-year foundations in the discipline.',
  master: 'Assume undergraduate coverage of the field; do not re-teach it.',
  doctorate: 'Assume comprehensive background; state only what the source adds.',
});

const NEUTRAL_REGISTER = 'Clear, neutral explanatory prose suitable for a general adult learner.';
const NEUTRAL_PRIOR = 'Assume only what the source material itself establishes.';

export class PersonalisationPolicy {
  public resolve(
    context: StudentContext,
    style: VideoStyle,
    direction?: ExtraDirection,
  ): NarrationBrief {
    const shared = {
      styleNote: style.narration,
      extraDirection: direction?.text,
    };

    if (context.isEmpty) {
      return {
        ...shared,
        register: NEUTRAL_REGISTER,
        assumedPriorKnowledge: NEUTRAL_PRIOR,
        structure: 'Follow the source material\'s own order of presentation.',
        emphasisedTopics: [],
        explicitInstructions: undefined,
      };
    }

    return {
      ...shared,
      register: context.level ? REGISTER[context.level] : NEUTRAL_REGISTER,
      assumedPriorKnowledge: context.level ? PRIOR_KNOWLEDGE[context.level] : NEUTRAL_PRIOR,
      structure: this.structureFor(context.goal),
      emphasisedTopics: context.weaknesses,
      explicitInstructions: context.instructions,
    };
  }

  /** `goal` sets structure: exam prep front-loads formulas, quick review compresses. */
  private structureFor(goal: string | undefined): string {
    if (!goal) return 'Follow the source material\'s own order of presentation.';
    const g = goal.toLowerCase();

    if (/exam|test|revis|prep/.test(g)) {
      return 'Front-load formulas, definitions and worked examples; close with the most examinable points.';
    }
    if (/quick|review|refresh|summar/.test(g)) {
      return 'Compress to conclusions and the reasoning that supports them; omit extended derivations.';
    }
    if (/deep|thorough|understand|learn/.test(g)) {
      return 'Build up from foundations, deriving results rather than stating them.';
    }
    return 'Follow the source material\'s own order of presentation.';
  }

  /**
   * Time allocation multiplier per topic — weaknesses get more of the runtime.
   * Capped so a long weakness list cannot starve the rest of the material.
   */
  public timeAllocationFor(topic: string, context: StudentContext): number {
    const weak = context.weaknesses.some((w) => topic.toLowerCase().includes(w.toLowerCase()));
    return weak ? 1.5 : 1.0;
  }
}
