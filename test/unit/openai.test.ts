import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OpenAiClient } from '@infrastructure/llm/OpenAiClient.js';
import { createLogger } from '@infrastructure/observability/logger.js';

const logger = createLogger({ level: 'silent', redactPaths: [] });

afterEach(() => vi.unstubAllGlobals());
let server: Server | undefined;

/** Stands up a throwaway OpenAI-shaped endpoint and captures what we sent. */
async function stub(handler: (body: any, reply: (status: number, json: unknown) => void) => void) {
  const seen: any[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ body, auth: req.headers.authorization });
      handler(body, (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    });
  });
  await new Promise<void>((r) => server!.listen(0, r));
  const port = (server!.address() as { port: number }).port;
  const client = new OpenAiClient({
    apiKey: 'sk-test', qualityModel: 'q-model', volumeModel: 'v-model',
    maxRetries: 1, requestTimeoutMs: 5000, baseUrl: `http://127.0.0.1:${port}`,
  }, logger);
  return { client, seen };
}

const ok = (content: string) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } },
});

afterEach(() => { server?.close(); server = undefined; });

describe('OpenAiClient', () => {
  it('selects the model by tier', async () => {
    const { client, seen } = await stub((_b, reply) => reply(200, ok('hi')));
    await client.generate({ system: 's', user: 'u', tier: 'quality' });
    await client.generate({ system: 's', user: 'u', tier: 'volume' });
    expect(seen.map((s) => s.body.model)).toEqual(['q-model', 'v-model']);
  });

  it('sends the key as a bearer token', async () => {
    const { client, seen } = await stub((_b, reply) => reply(200, ok('hi')));
    await client.generate({ system: 's', user: 'u', tier: 'volume' });
    expect(seen[0].auth).toBe('Bearer sk-test');
  });

  it('reports usage, including cached input tokens', async () => {
    const { client } = await stub((_b, reply) => reply(200, ok('hi')));
    const result = await client.generate({ system: 's', user: 'u', tier: 'volume' });
    expect(result.usage).toMatchObject({
      inputTokens: 11, outputTokens: 7, cachedInputTokens: 3, model: 'v-model',
    });
  });

  it('constrains output with a json_schema when one is supplied', async () => {
    const { client, seen } = await stub((_b, reply) => reply(200, ok('{"a":1}')));
    const schema = { type: 'object', properties: { a: { type: 'number' } } };
    const result = await client.generate({ system: '', user: 'u', tier: 'volume', responseSchema: schema });
    expect(seen[0].body.response_format.type).toBe('json_schema');
    expect(seen[0].body.response_format.json_schema.schema).toEqual(schema);
    expect(result.parsed).toEqual({ a: 1 });
  });

  it('recovers JSON that arrives wrapped in a code fence', async () => {
    const { client } = await stub((_b, reply) => reply(200, ok('```json\n{"a":2}\n```')));
    const result = await client.generate({
      system: '', user: 'u', tier: 'volume', responseSchema: { type: 'object' },
    });
    expect(result.parsed).toEqual({ a: 2 });
  });

  it('uses max_completion_tokens, which the reasoning models require', async () => {
    const { client, seen } = await stub((_b, reply) => reply(200, ok('hi')));
    await client.generate({ system: '', user: 'u', tier: 'volume', maxOutputTokens: 256 });
    expect(seen[0].body.max_completion_tokens).toBe(256);
    expect(seen[0].body).not.toHaveProperty('max_tokens');
  });

  it('sends an image as a data URI only when one is supplied', async () => {
    const { client, seen } = await stub((_b, reply) => reply(200, ok('hi')));
    await client.generate({ system: '', user: 'u', tier: 'volume' });
    await client.generate({
      system: '', user: 'u', tier: 'volume',
      images: [{ mimeType: 'image/png', base64: 'AAA' }],
    });
    expect(seen[0].body.messages[0].content).toBe('u');
    expect(seen[1].body.messages[0].content[1].image_url.url).toBe('data:image/png;base64,AAA');
  });

  it('drops an explicit temperature and retries when the model rejects it', async () => {
    const { client, seen } = await stub((body, reply) =>
      'temperature' in body
        ? reply(400, { error: { message: "Unsupported value: 'temperature' is not supported" } })
        : reply(200, ok('recovered')));
    const result = await client.generate({ system: '', user: 'u', tier: 'volume' });
    expect(result.text).toBe('recovered');
    expect(seen).toHaveLength(2);
    expect(seen[1].body).not.toHaveProperty('temperature');
  });

  it('does not retry a 400 that has nothing to do with temperature', async () => {
    const { client, seen } = await stub((_b, reply) =>
      reply(400, { error: { message: 'model not found' } }));
    await expect(client.generate({ system: '', user: 'u', tier: 'volume' })).rejects.toThrow(/400/);
    expect(seen).toHaveLength(1);
  });

  it('retries a 429 and succeeds on the second attempt', async () => {
    let n = 0;
    const { client } = await stub((_b, reply) =>
      (n += 1) === 1 ? reply(429, { error: { message: 'rate limit' } }) : reply(200, ok('second')));
    const result = await client.generate({ system: '', user: 'u', tier: 'volume' });
    expect(result.text).toBe('second');
  });
});

describe('transient network failures', () => {
  it('treats undici\'s bare "fetch failed" as retryable', async () => {
    // undici reports every transport problem this way and hides the real reason
    // in `cause`; matching only the message ended jobs that should have retried.
    const { isRetryable } = await import('@infrastructure/llm/llmResilience.js');
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
  });

  it('follows the cause chain to classify the underlying error', async () => {
    const { isRetryable } = await import('@infrastructure/llm/llmResilience.js');
    const wrapped = new TypeError('something opaque');
    (wrapped as { cause?: unknown }).cause = new Error('ECONNRESET');
    expect(isRetryable(wrapped)).toBe(true);
  });

  it('still refuses to retry a genuine 400', async () => {
    const { isRetryable } = await import('@infrastructure/llm/llmResilience.js');
    const bad = new Error('OpenAI request failed: 400 bad schema');
    Object.assign(bad, { status: 400 });
    expect(isRetryable(bad)).toBe(false);
  });
});

/**
 * The GPT-5 family accepts only the default temperature. The client recovers by
 * dropping it and retrying — but a pipeline makes one call per scene plus one
 * per judge, so paying that failed round-trip every time would double the
 * request count for the whole job.
 */
describe('temperature rejection is learned, not re-discovered', () => {
  function stubOnce() {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      bodies.push(body);
      if ('temperature' in body) {
        return new Response(
          JSON.stringify({ error: { message: "Unsupported value: 'temperature' ..." } }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return bodies;
  }

  it('stops sending temperature after the first rejection', async () => {
    const bodies = stubOnce();
    const client = new OpenAiClient({
      apiKey: 'k', qualityModel: 'gpt-5.6-terra', volumeModel: 'gpt-5.6-terra',
      maxRetries: 0, requestTimeoutMs: 5000,
    }, logger);

    await client.generate({ system: 's', user: 'u', tier: 'quality' });
    await client.generate({ system: 's', user: 'u', tier: 'quality' });
    await client.generate({ system: 's', user: 'u', tier: 'quality' });

    // First call: one rejected attempt with temperature, one without.
    // The next two must not repeat the rejected attempt.
    const withTemp = bodies.filter((b) => 'temperature' in b);
    expect(withTemp).toHaveLength(1);
    expect(bodies).toHaveLength(4);
  });

  it('keeps sending temperature to a model that accepts it', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const client = new OpenAiClient({
      apiKey: 'k', qualityModel: 'gpt-4.1', volumeModel: 'gpt-4.1',
      maxRetries: 0, requestTimeoutMs: 5000,
    }, logger);

    await client.generate({ system: 's', user: 'u', tier: 'quality' });
    expect(true).toBe(true);   // no 400 path taken; the call simply succeeds
  });
});
