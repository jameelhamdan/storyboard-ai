import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type PromptName =
  | '01-script-generation'
  | '02-scene-diagram'
  | '03-scene-judge'
  | '04-quiz-generation'
  | '05-image-reading'
  | '06-consolidation'
  | '08-visual-plan'
  | '09-story-plan-judge';

export interface RenderedPrompt {
  readonly system: string;
  readonly user: string;
}

/**
 * Prompts live in `prompts/*.md`, not in TypeScript string literals.
 *
 * They are the most-edited artefact in the service and the thing least likely to
 * be changed by whoever wrote the code around them — so they are plain Markdown a
 * non-engineer can open, read as documentation, and edit without a rebuild. The
 * files are also the specification: `docs/` refers to them by name.
 *
 * A `## System` heading splits the file into the system prompt and the user
 * template; a file without one is treated as entirely user-facing.
 *
 * Set `PROMPT_DIR` to point at a different directory — an experiment folder, or
 * a per-tenant override — without touching the image.
 */
export class PromptLibrary {
  private readonly cache = new Map<PromptName, { system: string; user: string }>();

  constructor(
    private readonly directory: string,
    /** Off in production: prompts are immutable there and re-reading costs I/O. */
    private readonly reloadEachTime = false,
  ) {}

  public render(name: PromptName, variables: Record<string, string | number> = {}): RenderedPrompt {
    const template = this.load(name);
    return {
      system: interpolate(template.system, variables, name),
      user: interpolate(template.user, variables, name),
    };
  }

  /** Fails at boot rather than mid-job if a prompt file is missing or malformed. */
  public verifyAll(names: readonly PromptName[]): void {
    const missing = names.filter((name) => !existsSync(this.pathFor(name)));
    if (missing.length > 0) {
      throw new Error(
        `Missing prompt file(s) in '${this.directory}': ${missing.map((m) => `${m}.md`).join(', ')}. ` +
        'Set PROMPT_DIR if they live elsewhere.',
      );
    }
    for (const name of names) this.load(name);
  }

  private load(name: PromptName): { system: string; user: string } {
    if (!this.reloadEachTime) {
      const cached = this.cache.get(name);
      if (cached) return cached;
    }

    const path = this.pathFor(name);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      throw new Error(`Cannot read prompt '${name}' at ${path}.`);
    }

    const parsed = splitSections(raw);
    if (!this.reloadEachTime) this.cache.set(name, parsed);
    return parsed;
  }

  private pathFor(name: PromptName): string {
    return join(this.directory, `${name}.md`);
  }
}

/**
 * The heading structure is the contract: everything under `## System` is the
 * system prompt, everything under `## User` is the user template. Prose before
 * the first heading is editorial notes for humans and is not sent to the model,
 * and `###` subheadings belong to whichever `##` section contains them.
 *
 * Scanned line by line rather than matched with a regex: an earlier version used
 * a lookahead ending in `\z`, which is not a JavaScript anchor — it is a literal
 * `z`, so a section silently truncated at the first word containing one.
 */
function splitSections(markdown: string): { system: string; user: string } {
  const lines = markdown.split(/\r?\n/);
  const sections = new Map<string, string[]>();
  let current: string | undefined;

  for (const line of lines) {
    // Exactly two hashes: `###` is a subheading within the current section.
    const heading = line.match(/^##(?!#)\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1]!.toLowerCase();
      sections.set(current, []);
      continue;
    }
    if (current) sections.get(current)!.push(line);
  }

  const system = (sections.get('system') ?? []).join('\n').trim();
  const user = (sections.get('user') ?? []).join('\n').trim();

  if (!system && !user) {
    // No headings at all: treat the whole file as one user prompt rather than
    // sending nothing, which fails confusingly at the provider.
    return { system: '', user: markdown.trim() };
  }
  return { system, user };
}

/**
 * `{{name}}` substitution.
 *
 * An unreplaced placeholder throws rather than reaching the model as literal
 * `{{output_language}}` — a prompt that silently asks for a language called
 * "output_language" is far harder to diagnose than a boot-time error.
 */
function interpolate(template: string, variables: Record<string, string | number>, name: string): string {
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    const value = variables[key];
    return value === undefined ? whole : String(value);
  });

  const leftover = rendered.match(/\{\{(\w+)\}\}/g);
  if (leftover) {
    throw new Error(
      `Prompt '${name}' has unfilled placeholder(s): ${[...new Set(leftover)].join(', ')}.`,
    );
  }
  return rendered;
}
