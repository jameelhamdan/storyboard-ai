import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { envSchema } from '@interfaces/config/schema.js';

/**
 * `.env.example` is the only documentation of what the service reads from the
 * environment, and it drifted: it advertised a `gemini` driver, `LLM_MODEL_*`
 * keys and a `RENDERER_DRIVER` switch that no code ever read. A key that is set
 * and silently ignored is worse than a missing one — the operator believes they
 * configured something.
 */
describe('.env.example', () => {
  const documented = new Set(
    [...readFileSync('.env.example', 'utf8').matchAll(/^#?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!),
  );
  const declared = new Set(Object.keys(envSchema.shape));

  it('documents every variable the schema declares', () => {
    expect([...declared].filter((key) => !documented.has(key)).sort()).toEqual([]);
  });

  it('documents no variable the schema does not read', () => {
    expect([...documented].filter((key) => !declared.has(key)).sort()).toEqual([]);
  });
});
