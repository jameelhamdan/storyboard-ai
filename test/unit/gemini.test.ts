import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { GeminiClient } from '@infrastructure/llm/GeminiClient.js';
import { toGeminiSchema } from '@infrastructure/llm/geminiSchema.js';
import { scriptSchema } from '@infrastructure/llm/schemas.js';
import { createLogger } from '@infrastructure/observability/logger.js';

const logger = createLogger({ level: 'silent', redactPaths: [] });
let server: Server | undefined;

/** Stands up a throwaway Gemini-shaped endpoint and captures what we sent. */
async function stub(handler: (body: any, reply: (status: number, json: unknown) => void) => void) {
  const seen: any[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ body: JSON.parse(raw), key: req.headers['x-goog-api-key'], url: req.url });
      handler(JSON.parse(raw), (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    });
  });
  await new Promise<void>((r) => server!.listen(0, r));
  const port = (server!.address() as { port: number }).port;
  const client = new GeminiClient({
    apiKey: 'gem-test', qualityModel: 'q-model', volumeModel: 'v-model',
    maxRetries: 1, requestTimeoutMs: 5000, baseUrl: `http://127.0.0.1:${port}`,
  }, logger);
  return { client, seen };
}

const ok = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: {
    promptTokenCount: 11, candidatesTokenCount: 7,
    thoughtsTokenCount: 5, cachedContentTokenCount: 3,
  },
});

afterEach(() => { server?.close(); server = undefined; });

describe('GeminiClient', () => {
  it('selects the model by tier, and puts it in the path rather than the body', async () => {
    const { client, seen } = await stub((_b, reply) => reply(200, ok('hi')));
    await client.generate({ system: 's', user: 'u', tier: 'quality' });
    await client.generate({ system: 's', user: 'u', tier: 'volume' });
    expect(seen.map((s) => s.url)).toEqual([
      '/v1beta/models/q-model:generateContent',
      '/v1beta/models/v-model:generateContent',
    ]);
  });

  it('sends the key as a header, never in the query string', async () => {
    const { client, seen } = await stub((_b, reply) => reply(200, ok('hi')));
    await client.generate({ system: 's', user: 'u', tier: 'volume' });
    expect(seen[0].key).toBe('gem-test');
    expect(seen[0].url).not.toContain('gem-test');
  });

  it('sends the system prompt as systemInstruction, not as a turn', async () => {
    const { client, seen } = await stub((_b, reply) => reply(200, ok('hi')));
    await client.generate({ system: 'you are a teacher', user: 'u', tier: 'volume' });
    expect(seen[0].body.systemInstruction.parts[0].text).toBe('you are a teacher');
    expect(JSON.stringify(seen[0].body.contents)).not.toContain('you are a teacher');
  });

  it('attaches images inline alongside the prompt text', async () => {
    const { client, seen } = await stub((_b, reply) => reply(200, ok('hi')));
    await client.generate({
      system: '', user: 'read this', tier: 'quality',
      images: [{ mimeType: 'image/png', base64: 'AAAA' }],
    });
    expect(seen[0].body.contents[0].parts).toEqual([
      { text: 'read this' },
      { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
    ]);
  });

  /**
   * Reasoning tokens are output the invoice charges for and the response does
   * not contain. Leaving them out made Gemini look 30-40% cheaper than it is on
   * exactly the calls this pipeline makes.
   */
  it('bills thinking tokens as output', async () => {
    const { client } = await stub((_b, reply) => reply(200, ok('hi')));
    const result = await client.generate({ system: 's', user: 'u', tier: 'volume' });
    expect(result.usage).toMatchObject({
      inputTokens: 11, outputTokens: 12, cachedInputTokens: 3, model: 'v-model',
    });
  });

  /**
   * Thoughts are billed as output, and on this pipeline's calls they dominate:
   * a two-token answer came back with 184 thought tokens behind it. The volume
   * tier's work is schema-validated downstream, so the deliberation buys nothing
   * there.
   */
  it('asks the volume tier to think less, and leaves the quality tier alone', async () => {
    const { client, seen } = await stub((_b, reply) => reply(200, ok('hi')));
    await client.generate({ system: 's', user: 'u', tier: 'volume' });
    await client.generate({ system: 's', user: 'u', tier: 'quality' });

    expect(seen[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    expect(seen[1].body.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  /**
   * Gemini 2.5 takes a thinking *budget* and 400s on the level. Thinking is a
   * cost decision, never a correctness one, so a model that refuses the field
   * gets the call without it rather than an error.
   */
  it('drops thinkingConfig for a model that rejects it, and stops sending it', async () => {
    let calls = 0;
    const { client, seen } = await stub((body, reply) => {
      calls += 1;
      if (body.generationConfig?.thinkingConfig) {
        reply(400, { error: { message: 'Unknown name "thinkingLevel" at generation_config' } });
      } else {
        reply(200, ok('hi'));
      }
    });

    await client.generate({ system: 's', user: 'u', tier: 'volume' });
    await client.generate({ system: 's', user: 'u', tier: 'volume' });

    expect(calls).toBe(3);   // rejected, retried without, then never sent again
    expect(seen[2].body.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  it('reports a truncated response as a budget problem, not as malformed JSON', async () => {
    const { client } = await stub((_b, reply) => reply(200, {
      candidates: [{ content: { parts: [{ text: '{"scenes":' }] }, finishReason: 'MAX_TOKENS' }],
    }));
    await expect(client.generate({
      system: 's', user: 'u', tier: 'volume', responseSchema: scriptSchema as never,
    })).rejects.toThrow(/output ceiling/);
  });

  /** A safety block is a 200 with no candidate; it must not read as bad JSON. */
  it('names a safety block for what it is', async () => {
    const { client } = await stub((_b, reply) => reply(200, { promptFeedback: { blockReason: 'SAFETY' } }));
    await expect(client.generate({
      system: 's', user: 'u', tier: 'volume', responseSchema: scriptSchema as never,
    })).rejects.toThrow(/refused the request: SAFETY/);
  });

  it('retries a 429 and honours the retryDelay the error body states', async () => {
    let calls = 0;
    const { client } = await stub((_b, reply) => {
      calls += 1;
      if (calls === 1) reply(429, { error: { message: 'quota', details: [{ retryDelay: '0.01s' }] } });
      else reply(200, ok('recovered'));
    });
    const result = await client.generate({ system: 's', user: 'u', tier: 'volume' });
    expect(result.text).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('does not retry a 400 — the request is wrong and will be wrong again', async () => {
    let calls = 0;
    const { client } = await stub((_b, reply) => { calls += 1; reply(400, { error: 'bad' }); });
    await expect(client.generate({ system: 's', user: 'u', tier: 'volume' })).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });
});

/**
 * Gemini's responseSchema is an OpenAPI Schema object, not JSON Schema: it names
 * types in SCREAMING_CASE and rejects the whole request on a keyword it does not
 * know. The translation is what lets both providers be handed the same schemas.
 */
describe('toGeminiSchema', () => {
  it('uppercases types and preserves the shape', () => {
    const converted = toGeminiSchema(scriptSchema as never) as any;
    expect(converted.type).toBe('OBJECT');
    expect(converted.properties.scenes.type).toBe('ARRAY');
    expect(converted.properties.scenes.items.properties.visualIntent.type).toBe('STRING');
    expect(converted.properties.scenes.items.properties.visualIntent.enum).toContain('cycle');
    expect(converted.properties.scenes.items.required).toEqual(['sentences', 'visualIntent']);
  });

  it('drops keywords Gemini rejects rather than passing them through', () => {
    const converted = toGeminiSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'string', additionalProperties: false } },
    }) as any;
    expect(converted).not.toHaveProperty('$schema');
    expect(converted).not.toHaveProperty('additionalProperties');
    expect(converted.properties.a).not.toHaveProperty('additionalProperties');
  });

  it('states property order, which is the order the model answers in', () => {
    const converted = toGeminiSchema({
      type: 'object',
      properties: { passed: { type: 'boolean' }, note: { type: 'string' } },
    }) as any;
    expect(converted.propertyOrdering).toEqual(['passed', 'note']);
  });
});
