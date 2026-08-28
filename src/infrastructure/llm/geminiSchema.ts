/**
 * JSON Schema as written in `schemas.ts` → the subset Gemini accepts.
 *
 * Gemini's `responseSchema` is an OpenAPI 3.0 Schema object, not JSON Schema:
 * it names its types in SCREAMING_CASE and rejects the request outright when it
 * meets a keyword it does not know — `additionalProperties` and `$schema` are
 * the two our schemas would otherwise carry in. Translating here rather than
 * keeping a second copy of every schema is what stops the two providers being
 * given different contracts for the same call.
 */

/** Everything Gemini reads. Anything else is dropped rather than passed on. */
const KEPT = [
  'description', 'enum', 'format', 'nullable',
  'minItems', 'maxItems', 'required',
] as const;

export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const type = schema['type'];
  if (typeof type === 'string') out['type'] = type.toUpperCase();

  for (const key of KEPT) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }

  const properties = schema['properties'];
  if (properties && typeof properties === 'object') {
    out['properties'] = Object.fromEntries(
      Object.entries(properties as Record<string, Record<string, unknown>>)
        .map(([name, value]) => [name, toGeminiSchema(value)]),
    );
    /**
     * Gemini emits properties in the order it is given them, and the order of a
     * JSON object's keys is otherwise unspecified — which matters because a
     * model asked for `passed` before `note` reasons in that order too. Stating
     * it explicitly makes the generation deterministic in the one way we can
     * control.
     */
    out['propertyOrdering'] = Object.keys(properties as object);
  }

  const items = schema['items'];
  if (items && typeof items === 'object') {
    out['items'] = toGeminiSchema(items as Record<string, unknown>);
  }

  return out;
}
