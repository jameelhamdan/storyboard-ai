import type {
  ScriptGeneratorPort, ScriptGenerationResult, GeneratedScene, GeneratedSentence,
} from '@application/port/ScriptGeneratorPort.js';
import type { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import type { Language } from '@domain/shared/Language.js';
import type { Duration } from '@domain/shared/Duration.js';
import type { NarrationBrief } from '@domain/script/NarrationScript.js';
import { toDiagramShape, type DiagramShape } from '@domain/script/DiagramShape.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';
import { Citation } from '@domain/content/Citation.js';
import { GenerationFailedError } from '@domain/error/GenerationFailedError.js';
import type { LlmClientPort } from '@application/port/LlmClientPort.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import type { PromptLibrary } from './PromptLibrary.js';
import { scriptSchema } from './schemas.js';

interface ScriptResponse {
  scenes: {
    sentences: { text: string; kind: string; citations: string[] }[];
    visualIntent: string;
  }[];
}

/**
 * The source-lock-critical call, so it runs on the quality tier: grounding,
 * translation quality and structural coherence all live here, and a cheaper
 * model that paraphrases the source produces a video that cites material it
 * did not actually say.
 */
export class PromptedScriptGenerator implements ScriptGeneratorPort {
  constructor(
    private readonly client: LlmClientPort,
    private readonly prompts: PromptLibrary,
    /**
     * The image libraries this deployment can reach — its capability, as opposed
     * to the job's permission.
     *
     * The script stage is where `illustration` is chosen, so it is where the
     * option has to be withdrawn: a model that picks a shape nothing can fill
     * costs a wasted scene and a fallback board. The prompt is told directly
     * rather than the shape being edited out of the schema, because the enum is
     * shared with the domain and a per-deployment schema is a second vocabulary.
     */
    private readonly configuredSources: readonly ImageSourceId[] = [],
    private readonly logger?: LoggerPort,
  ) {}

  public async generate(input: {
    content: ConsolidatedContent;
    outputLanguage: Language;
    targetDuration: Duration;
    wordBudget: number;
    brief: NarrationBrief;
    imageSources: readonly ImageSourceId[];
    revisionNotes?: readonly string[];
    signal?: AbortSignal;
  }): Promise<ScriptGenerationResult> {
    // Chunk ids are the citation vocabulary: the model can only cite what it is
    // shown, and every id it returns is checked back against this map.
    const byId = new Map(input.content.chunks.map((c) => [c.id, c]));

    const material = input.content.chunks
      .map((c) => `[${c.id}] ${c.text}`)
      .join('\n\n');

    const prompt = this.prompts.render('01-script-generation', {
      output_language: input.outputLanguage.code,
      target_duration_seconds: Math.round(input.targetDuration.seconds),
      word_budget: input.wordBudget,
      register: input.brief.register,
      prior_knowledge: input.brief.assumedPriorKnowledge,
      structure: input.brief.structure,
      emphasised_topics: input.brief.emphasisedTopics.join(', ') || 'none',
      instructions: input.brief.explicitInstructions ?? 'none',
      style_note: input.brief.styleNote,
      extra_direction: input.brief.extraDirection ?? 'none',
      // Both halves have to agree: the deployment must have a library and the
      // caller must want one.
      images_available: this.imagesEnabledFor(input.imageSources) ? 'yes' : 'no',
      revision_notes: input.revisionNotes?.length
        ? input.revisionNotes.map((note) => `- ${note}`).join('\n')
        : 'none',
      material,
    });

    const result = await this.client.generate<ScriptResponse>({
      system: prompt.system,
      user: prompt.user,
      tier: 'quality',
      responseSchema: scriptSchema as unknown as Record<string, unknown>,
      maxOutputTokens: 16384,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const parsed = result.parsed;
    if (!parsed?.scenes?.length) {
      throw new GenerationFailedError('The script generator returned no scenes.', 'script');
    }

    const citations = new Map<string, Citation>();
    const scenes: GeneratedScene[] = [];

    parsed.scenes.forEach((scene, index) => {
      const sentences: GeneratedSentence[] = (scene.sentences ?? [])
        .map((raw) => {
          // A citation naming a chunk that was not supplied is a hallucinated
          // source. Dropping it here means ScriptScopingPolicy sees the sentence
          // as uncited and rejects it, rather than the pipeline trusting a dead id.
          const valid = (raw.citations ?? []).filter((id) => byId.has(id));
          // Anything not explicitly `teach` is held to the assertion rules. A
          // provider that drops the field must not thereby exempt a sentence
          // from needing a citation.
          const kind = raw.kind === 'teach' ? 'teach' as const : 'assert' as const;
          return { text: raw.text.trim(), kind, citationIds: kind === 'teach' ? [] : valid };
        })
        .filter((sentence) => sentence.text.length > 0);

      for (const id of sentences.flatMap((s) => s.citationIds)) {
        if (!citations.has(id)) {
          const chunk = byId.get(id)!;
          citations.set(id, Citation.of(id, chunk.refs, chunk.text.slice(0, 200)));
        }
      }

      const sourced = sentences.filter((s) => s.kind === 'assert');

      scenes.push({
        index,
        sentences,
        narration: sentences.map((s) => s.text).join(' '),
        sourcedNarration: sourced.map((s) => s.text).join(' '),
        citationIds: [...new Set(sourced.flatMap((s) => s.citationIds))],
        // Guarded rather than trusted: the enum is enforced by the response
        // schema, but a provider that ignores it must not poison the shape.
        visualIntent: this.shapeFor(scene.visualIntent, index, input.imageSources),
      });
    });

    return { scenes, citations: [...citations.values()], usage: result.usage };
  }

  /**
   * `illustration` asked for without an image library becomes `focus`.
   *
   * Loud rather than silent, because the two are not equivalent: the model chose
   * to *show* something and gets to state it instead. The prompt already says
   * the option is unavailable, so reaching this means the model ignored it — and
   * the alternative, letting it through, is a scene that will certainly fall
   * back to the built-in board three stages later with no explanation attached.
   */
  /** Permitted by the job *and* reachable by the deployment. */
  private imagesEnabledFor(requested: readonly ImageSourceId[]): boolean {
    return requested.some((id) => this.configuredSources.includes(id));
  }

  private shapeFor(
    raw: string,
    sceneIndex: number,
    requested: readonly ImageSourceId[],
  ): DiagramShape {
    const shape = toDiagramShape(raw);
    if (shape === 'illustration' && !this.imagesEnabledFor(requested)) {
      this.logger?.warn(
        { sceneIndex },
        'scene asked for an illustration but images are unavailable for this job; using focus instead',
      );
      return 'focus';
    }
    return shape;
  }
}
