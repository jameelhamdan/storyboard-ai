import { describe, it, expect } from 'vitest';
import { PromptedScriptGenerator } from '@infrastructure/llm/PromptedScriptGenerator.js';
import { PromptLibrary } from '@infrastructure/llm/PromptLibrary.js';
import type { LlmClientPort, GenerateResult } from '@application/port/LlmClientPort.js';
import { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { Language } from '@domain/shared/Language.js';
import { Duration } from '@domain/shared/Duration.js';
import { Scene } from '@domain/script/Scene.js';
import { Citation } from '@domain/content/Citation.js';

/**
 * Narration is a list of sentences, each either an assertion or a teaching line,
 * and the split is what lets the script explain rather than paraphrase. These
 * pin the two things that must stay true of it:
 *
 * - the viewer hears everything;
 * - `traceability.json` records only what the material actually supports.
 *
 * Get either wrong and the change is either pointless or a hole in FR-9.
 */
const chunks = [
  ContentChunk.of({
    id: 'c1', text: 'Lithium ions move between two electrodes.',
    refs: [SourceRef.page('doc', 1)], kind: 'typed_document',
  }),
  ContentChunk.of({
    id: 'c2', text: 'Nothing is consumed and nothing is created.',
    refs: [SourceRef.page('doc', 1)], kind: 'typed_document',
  }),
];

const content = ConsolidatedContent.of({
  chunks, duplicatesMerged: 0, sourceCount: 1, distinctConcepts: 2,
});

function clientReturning(scenes: unknown): LlmClientPort {
  return {
    modelFor: () => 'fake',
    generate: async <T,>(): Promise<GenerateResult<T>> => ({
      text: '',
      parsed: { scenes } as T,
      usage: { inputTokens: 0, outputTokens: 0, model: 'fake' },
    }),
  };
}

const generate = (scenes: unknown) =>
  new PromptedScriptGenerator(clientReturning(scenes), new PromptLibrary('prompts')).generate({
    content,
    outputLanguage: Language.of('en'),
    targetDuration: Duration.fromSeconds(60),
    wordBudget: 150,
    imageSources: [],
    brief: {
      register: 'r', assumedPriorKnowledge: 'p', structure: 's',
      emphasisedTopics: [], styleNote: 'n',
      explicitInstructions: undefined, extraDirection: undefined,
    },
  });

describe('assert and teach sentences', () => {
  const scene = {
    visualIntent: 'cycle',
    sentences: [
      { text: 'Think of it as one crowd moving between two rooms.', kind: 'teach', citations: [] },
      { text: 'Lithium ions move between two electrodes.', kind: 'assert', citations: ['c1'] },
      { text: 'Nothing is consumed.', kind: 'assert', citations: ['c2'] },
    ],
  };

  it('speaks every sentence, in order', async () => {
    const result = await generate([scene]);
    expect(result.scenes[0]?.narration).toBe(
      'Think of it as one crowd moving between two rooms. ' +
      'Lithium ions move between two electrodes. Nothing is consumed.',
    );
  });

  it('records only the assertions as sourced', async () => {
    const result = await generate([scene]);
    expect(result.scenes[0]?.sourcedNarration)
      .toBe('Lithium ions move between two electrodes. Nothing is consumed.');
    expect(result.scenes[0]?.sourcedNarration).not.toContain('one crowd');
  });

  it('attributes the scene only to citations an assertion made', async () => {
    const result = await generate([scene]);
    expect(result.scenes[0]?.citationIds).toEqual(['c1', 'c2']);
  });

  /**
   * A citation naming a chunk that was never supplied is a hallucinated source.
   * Dropping it here leaves the sentence uncited, so ScriptScopingPolicy rejects
   * it — rather than the pipeline trusting a dead id.
   */
  it('drops a citation naming a chunk that does not exist', async () => {
    const result = await generate([{
      visualIntent: 'focus',
      sentences: [{ text: 'A claim.', kind: 'assert', citations: ['nope'] }],
    }]);
    expect(result.scenes[0]?.sentences[0]?.citationIds).toEqual([]);
  });

  /**
   * A provider that omits or garbles `kind` must not thereby exempt a sentence
   * from needing a citation — the permissive case has to be the one that is
   * explicitly asked for.
   */
  it('treats an unrecognised kind as an assertion', async () => {
    const result = await generate([{
      visualIntent: 'focus',
      sentences: [{ text: 'A claim.', kind: 'whatever', citations: ['c1'] }],
    }]);
    expect(result.scenes[0]?.sentences[0]?.kind).toBe('assert');
    expect(result.scenes[0]?.sourcedNarration).toBe('A claim.');
  });

  it('never lets a teaching sentence carry a citation into the claim set', async () => {
    const result = await generate([{
      visualIntent: 'focus',
      sentences: [{ text: 'An analogy.', kind: 'teach', citations: ['c1'] }],
    }]);
    // Stripped here; ScriptScopingPolicy separately rejects the sentence, so a
    // model doing this loudly fails rather than quietly borrowing a citation.
    expect(result.scenes[0]?.sentences[0]?.citationIds).toEqual([]);
    expect(result.scenes[0]?.citationIds).toEqual([]);
  });
});

describe('Scene carries the sourced text separately', () => {
  const scene = (over: { sourcedText?: string } = {}) => Scene.of({
    index: 0,
    spokenText: 'An analogy. A claim.',
    writtenText: 'An analogy. A claim.',
    citations: [Citation.of('c1', [SourceRef.page('doc', 1)])],
    visualIntent: 'focus',
    estimatedDuration: Duration.fromSeconds(5),
    ...over,
  });

  it('keeps what was said apart from what was claimed', () => {
    const s = scene({ sourcedText: 'A claim.' });
    expect(s.writtenText).toBe('An analogy. A claim.');
    expect(s.sourcedText).toBe('A claim.');
  });

  /** A caller with no teaching sentences must not have to think about this. */
  it('defaults to the written text', () => {
    expect(scene().sourcedText).toBe('An analogy. A claim.');
  });
});
