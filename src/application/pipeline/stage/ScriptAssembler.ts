import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import type { ScriptGenerationResult } from '../../port/ScriptGeneratorPort.js';
import type { NarrationBrief } from '@domain/script/NarrationScript.js';
import { NarrationScript } from '@domain/script/NarrationScript.js';
import { Scene } from '@domain/script/Scene.js';
import type { Language } from '@domain/shared/Language.js';
import { GenerationFailedError } from '@domain/error/GenerationFailedError.js';

/** Rewrites narration into the form TTS will actually speak. */
export interface TextNormalizerPort {
  normalize(text: string, language: string): string;
}

/**
 * A generator's raw answer → a validated `NarrationScript`.
 *
 * Extracted from `GenerateScriptStage` when the plan review gained the power to
 * ask for a rewrite. The revision comes back in exactly the same shape as the
 * first attempt and has to survive exactly the same checks — source scoping,
 * citation resolution, spoken-form normalisation — and the only thing worse
 * than duplicating those in the reviewing stage would be *not* duplicating them
 * and letting a revised script through on weaker terms than the original.
 *
 * The order matters and is the reason this is one unit rather than three
 * helpers: normalisation runs last, so everything downstream — the illustrator,
 * the `data-on` anchors, the synthesiser — sees one identical spoken form, and
 * the written form is kept on the Scene for subtitles.
 */
export class ScriptAssembler {
  constructor(private readonly normalizer: TextNormalizerPort) {}

  public assemble(input: {
    result: ScriptGenerationResult;
    language: Language;
    brief: NarrationBrief;
    stage: StageName;
    ctx: PipelineContext;
  }): NarrationScript {
    const { result, language, ctx, stage } = input;
    const { duration, scriptScoping } = ctx.config.policies;

    if (result.scenes.length === 0) {
      throw new GenerationFailedError('The script generator returned no scenes.', stage);
    }

    // FR-9's deterministic half, per sentence rather than per scene. It used to
    // pass the whole scene's narration with `citationIds[0]` standing in for it,
    // so a scene whose later sentences cited nothing passed on the strength of
    // its first — the prompt described the strict rule and the code did not
    // enforce it.
    const violations = scriptScoping.validate(
      result.scenes.flatMap((scene) => scene.sentences.map((sentence) => ({
        sentence: sentence.text,
        kind: sentence.kind,
        citationIds: sentence.citationIds,
      }))),
      result.citations,
    );
    if (violations.length > 0) {
      throw new GenerationFailedError(
        `${violations.length} narration sentence(s) lack a resolvable citation.`,
        stage,
        { violations: violations.slice(0, 5) },
      );
    }

    const byId = new Map(result.citations.map((c) => [c.id, c]));

    const scenes = result.scenes.map((generated) => {
      const spoken = this.normalizer.normalize(generated.narration, language.code);
      return Scene.of({
        index: generated.index,
        spokenText: spoken,
        writtenText: generated.narration,
        // What an audit runs against: the assertions only, with the teaching
        // sentences left out. They state nothing about the subject, so recording
        // them as sourced claims would be the one way this could weaken FR-9.
        sourcedText: generated.sourcedNarration,
        citations: generated.citationIds.map((id) => byId.get(id)).filter((c) => c !== undefined),
        visualIntent: generated.visualIntent,
        estimatedDuration: duration.estimateSpokenDuration(
          spoken.split(/\s+/).filter(Boolean).length, language.code,
        ),
      });
    });

    return NarrationScript.of(scenes, language, input.brief);
  }
}
