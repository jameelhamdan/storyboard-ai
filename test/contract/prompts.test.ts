import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PromptLibrary, type PromptName } from '@infrastructure/llm/PromptLibrary.js';
import { envSchema } from '@interfaces/config/schema.js';

const REQUIRED: PromptName[] = [
  '01-script-generation', '02-scene-diagram', '03-scene-judge',
  '04-quiz-generation', '05-image-reading', '06-consolidation', '08-visual-plan',
  '09-story-plan-judge',
];

describe('prompt library', () => {
  const prompts = new PromptLibrary('prompts');

  it('finds every prompt the pipeline asks for', () => {
    expect(() => prompts.verifyAll(REQUIRED)).not.toThrow();
  });

  it('has no orphan prompt files', () => {
    const onDisk = readdirSync('prompts').filter((f) => f.endsWith('.md')).map((f) => f.replace('.md', ''));
    expect(onDisk.sort()).toEqual([...REQUIRED].sort());
  });

  it('gives every prompt a non-empty system section', () => {
    for (const name of REQUIRED) {
      const rendered = prompts.render(name, allPlaceholdersFor(name));
      expect(rendered.system.length, name).toBeGreaterThan(50);
    }
  });

  /**
   * An unfilled `{{placeholder}}` reaching the model is far harder to diagnose
   * than a thrown error — the model just answers a question nobody asked.
   */
  it('throws rather than sending an unfilled placeholder', () => {
    expect(() => prompts.render('01-script-generation', {})).toThrow(/unfilled placeholder/i);
  });

  it('substitutes every placeholder when all are supplied', () => {
    for (const name of REQUIRED) {
      const rendered = prompts.render(name, allPlaceholdersFor(name));
      expect(`${rendered.system}${rendered.user}`, name).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it('reports a missing prompt directory clearly', () => {
    expect(() => new PromptLibrary('does-not-exist').verifyAll(REQUIRED))
      .toThrow(/Missing prompt file|PROMPT_DIR/);
  });
});

describe('.env.example', () => {
  /**
   * The brief requires a .env.example with every key documented. A key added to
   * the schema but not the example is a key nobody deploying this will set.
   */
  it('documents every variable the config schema accepts', () => {
    const schemaSource = readFileSync('src/interfaces/config/schema.ts', 'utf8');
    const block = schemaSource.slice(
      schemaSource.indexOf('export const envSchema'),
    );
    const keys = [...new Set(
      [...block.slice(0, block.indexOf('});')).matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!),
    )];

    const example = readFileSync('.env.example', 'utf8');
    const undocumented = keys.filter((k) => !new RegExp(`^#?\\s*${k}=`, 'm').test(example));

    expect(undocumented).toEqual([]);
    expect(keys.length).toBeGreaterThan(20);
  });

  it('parses with only the values .env.example sets', () => {
    const example = readFileSync('.env.example', 'utf8');
    const env: Record<string, string> = {};
    for (const line of example.split('\n')) {
      const match = line.match(/^([A-Z][A-Z0-9_]+)=(.*)$/);
      if (match) env[match[1]!] = match[2]!;
    }
    expect(() => envSchema.parse(env)).not.toThrow();
  });
});

/**
 * The variables each adapter actually supplies, transcribed from its call site.
 *
 * This is the half the library cannot check for itself: `render()` proves a
 * prompt's placeholders were all filled, but not that the *adapter* is the thing
 * filling them. The two were written separately and drifted — the prompt files
 * still used Handlebars names from an earlier draft, so the first real LLM
 * call would have thrown on an unfilled placeholder.
 */
const SUPPLIED_BY_ADAPTER: Record<PromptName, readonly string[]> = {
  '01-script-generation': [
    'output_language', 'target_duration_seconds', 'word_budget', 'register',
    'prior_knowledge', 'structure', 'emphasised_topics', 'instructions', 'material',
    'style_note', 'extra_direction', 'images_available', 'revision_notes',
  ],
  '02-scene-diagram': ['scene'],
  '03-scene-judge': ['narration', 'html', 'source', 'planned_concept'],
  '04-quiz-generation': ['output_language', 'script'],
  '05-image-reading': [],
  '06-consolidation': [],
  '08-visual-plan': ['language', 'scenes', 'style', 'direction'],
  '09-story-plan-judge': [
    'target_duration_seconds', 'output_language', 'direction', 'material', 'plan',
  ],
};

describe('prompt files and their adapters agree', () => {
  it.each(REQUIRED)('%s declares only placeholders its adapter supplies', (name) => {
    const declared = placeholdersIn(name);
    const supplied = new Set(SUPPLIED_BY_ADAPTER[name]);

    const unsupplied = declared.filter((key) => !supplied.has(key));
    expect(unsupplied, `${name} uses placeholders no adapter fills`).toEqual([]);
  });

  it.each(REQUIRED)('%s renders with exactly what its adapter passes', (name) => {
    const args = Object.fromEntries(SUPPLIED_BY_ADAPTER[name].map((k) => [k, `<${k}>`]));
    expect(() => new PromptLibrary('prompts').render(name, args)).not.toThrow();
  });

  it('has no adapter supplying a variable the prompt ignores', () => {
    for (const name of REQUIRED) {
      const declared = new Set(placeholdersIn(name));
      const unused = SUPPLIED_BY_ADAPTER[name].filter((k) => !declared.has(k));
      // Not fatal, but it means an adapter is computing something for nothing.
      expect(unused, `${name}: adapter supplies unused variables`).toEqual([]);
    }
  });
});

function placeholdersIn(name: PromptName): string[] {
  const raw = readFileSync(`prompts/${name}.md`, 'utf8');
  return [...new Set([...raw.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))];
}

/** Every `{{name}}` the file actually contains, filled with a marker. */
function allPlaceholdersFor(name: PromptName): Record<string, string> {
  return Object.fromEntries(placeholdersIn(name).map((k) => [k, `<${k}>`]));
}
