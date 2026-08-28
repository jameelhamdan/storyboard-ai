import type { ScriptGeneratorPort, ScriptGenerationResult } from '@application/port/ScriptGeneratorPort.js';
import type { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import type { Duration } from '@domain/shared/Duration.js';
import type { GeneratedScene } from '@application/port/ScriptGeneratorPort.js';
import { DIAGRAM_SHAPES } from '@domain/script/DiagramShape.js';
import { Citation } from '@domain/content/Citation.js';

/**
 * Deterministic stand-in for the real LLM adapters.
 *
 * It is not a mock that returns fixtures: it does real work — splitting
 * consolidated content into scene-sized pieces and citing the chunk each came
 * from — so the whole pipeline downstream of it is genuinely exercised, and the
 * M2 slice produces a real MP4 without an API key or a cent of spend.
 *
 * Because every sentence cites the chunk it was derived from, source-lock holds
 * trivially here. That is a property of the stub, not evidence about the model.
 */
export class StubScriptGenerator implements ScriptGeneratorPort {
  private static readonly TARGET_SCENE_WORDS = 45;

  public async generate(input: {
    content: ConsolidatedContent;
    targetDuration: Duration;
    wordBudget: number;
  }): Promise<ScriptGenerationResult> {
    const citations: Citation[] = [];
    const scenes: GeneratedScene[] = [];
    let budgetLeft = input.wordBudget;

    // Scenes are cut on sentence boundaries within each chunk, not one-per-chunk:
    // a single-page PDF is one chunk but many scenes' worth of material, and
    // one-per-chunk would produce a single 3-minute scene with one quiz moment.
    for (const chunk of input.content.chunks) {
      if (budgetLeft <= 0) break;

      const citationId = `c${citations.length}`;
      citations.push(Citation.of(citationId, chunk.refs, chunk.text.slice(0, 120)));

      for (const segment of splitIntoScenes(chunk.text, StubScriptGenerator.TARGET_SCENE_WORDS)) {
        if (budgetLeft <= 0) break;

        const words = segment.split(/\s+/).filter(Boolean).slice(0, budgetLeft);
        if (words.length < 5) continue;
        budgetLeft -= words.length;

        const raw = words.join(' ').trim();
        const narration = /[.!?]$/.test(raw) ? raw : `${raw}.`;
        scenes.push({
          index: scenes.length,
          // Every stub sentence is an assertion. The stub has no reason to
          // invent a teaching sentence, and a scene of uncited narration would
          // exercise the scoping policy's *permissive* path rather than its
          // real one.
          sentences: [{ text: narration, kind: 'assert', citationIds: [citationId] }],
          narration,
          sourcedNarration: narration,
          citationIds: [citationId],
          // Cycles the vocabulary so a stub run renders several different
          // diagrams rather than nine copies of one — which is what makes the
          // free stub run useful for eyeballing the visual language.
          visualIntent: DIAGRAM_SHAPES[scenes.length % DIAGRAM_SHAPES.length]!,
        });
      }
    }

    // Content that survived consolidation but yielded no usable sentence still
    // needs one scene, or the pipeline fails later with a less clear error.
    if (scenes.length === 0 && input.content.chunks[0]) {
      const chunk = input.content.chunks[0];
      citations.push(Citation.of('c0', chunk.refs, chunk.text.slice(0, 120)));
      const narration = chunk.text.split(/\s+/).slice(0, input.wordBudget).join(' ');
      scenes.push({
        index: 0,
        sentences: [{ text: narration, kind: 'assert', citationIds: ['c0'] }],
        narration,
        sourcedNarration: narration,
        citationIds: ['c0'],
        visualIntent: 'focus',
      });
    }

    return {
      scenes,
      citations,
      usage: { inputTokens: 0, outputTokens: 0, model: 'stub' },
    };
  }
}

/** Groups sentences into scene-sized runs, never splitting mid-sentence (FR-4). */
function splitIntoScenes(text: string, targetWords: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [text];
  const scenes: string[] = [];
  let buffer: string[] = [];
  let words = 0;

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    const count = trimmed.split(/\s+/).filter(Boolean).length;
    buffer.push(trimmed);
    words += count;

    if (words >= targetWords) {
      scenes.push(buffer.join(' '));
      buffer = [];
      words = 0;
    }
  }
  if (buffer.length > 0) scenes.push(buffer.join(' '));

  return scenes;
}
