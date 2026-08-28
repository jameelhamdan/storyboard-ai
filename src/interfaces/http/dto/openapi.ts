import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

/**
 * The zod schemas in `schemas.ts` are the single definition of every request and
 * response shape. This renders them into the JSON Schema that Fastify's OpenAPI
 * generator consumes, so `/docs` describes responses rather than only paths —
 * deliverable 3 asks for docs a caller can actually integrate against.
 *
 * `$refStrategy: 'none'` inlines definitions: Fastify's generator does not
 * resolve `$ref` pointers into its own components section, and a doc full of
 * dangling refs is worse than a verbose one.
 */
export function jsonSchema(schema: ZodTypeAny, description?: string): Record<string, unknown> {
  const rendered = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'openApi3' }) as Record<string, unknown>;
  return description ? { ...rendered, description } : rendered;
}
