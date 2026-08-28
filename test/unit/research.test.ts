import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchTopicStage } from '@application/pipeline/stage/ResearchTopicStage.js';
import type { PipelineContext } from '@application/pipeline/PipelineContext.js';
import type { ValidatedInput } from '@application/pipeline/stage/types.js';
import type { WebSearchPort, SearchHit } from '@application/port/WebSearchPort.js';
import type { LlmClientPort } from '@application/port/LlmClientPort.js';
import { GeminiGroundedSearch } from '@infrastructure/search/GeminiGroundedSearch.js';
import { ResearchPolicy, type ResearchMode } from '@domain/policy/ResearchPolicy.js';
import { ExtraDirection } from '@domain/media/VideoStyle.js';
import { SharedVolumeWorkspace } from '@infrastructure/storage/SharedVolumeWorkspace.js';
import { CostMeter, DEFAULT_PRICING } from '@infrastructure/observability/CostMeter.js';
import { createLogger } from '@infrastructure/observability/logger.js';

const logger = createLogger({ level: 'silent', redactPaths: [] });
afterEach(() => vi.unstubAllGlobals());

/** Answers with a fixed page list, and records what it was asked. */
function searchReturning(...rounds: SearchHit[][]): WebSearchPort & { queries: string[] } {
  let call = 0;
  const queries: string[] = [];
  return {
    name: 'test',
    queries,
    async search(input) {
      queries.push(input.query);
      const hits = rounds[Math.min(call, rounds.length - 1)] ?? [];
      call += 1;
      return hits.slice(0, input.limit);
    },
  };
}

/** Plans queries. Records the prompts so we can assert a later round differs. */
function plannerReturning(...queriesPerRound: string[][]): LlmClientPort & { prompts: string[] } {
  let call = 0;
  const prompts: string[] = [];
  return {
    prompts,
    modelFor: () => 'stub',
    async generate(options) {
      prompts.push(options.user);
      const queries = queriesPerRound[Math.min(call, queriesPerRound.length - 1)] ?? [];
      call += 1;
      return {
        text: '',
        parsed: { queries } as never,
        usage: { inputTokens: 1, outputTokens: 1, model: 'stub' },
      };
    },
  };
}

const page = (url: string, title = url): SearchHit => ({ url, title, snippet: '' });

async function contextFor(
  research: ResearchMode,
  options: { direction?: string; limits?: { maxRounds: number; queriesPerRound: number; maxSources: number } } = {},
): Promise<PipelineContext> {
  const noop = () => {};
  const root = await mkdtemp(join(tmpdir(), 'research-'));
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log };

  return {
    job: {
      features: { research },
      direction: options.direction ? ExtraDirection.of(options.direction) : undefined,
    } as unknown as PipelineContext['job'],
    config: {
      policies: {
        research: new ResearchPolicy(
          options.limits ?? { maxRounds: 2, queriesPerRound: 3, maxSources: 6 },
        ),
      },
    } as unknown as PipelineContext['config'],
    logger: log as unknown as PipelineContext['logger'],
    costMeter: new CostMeter(DEFAULT_PRICING, {
      llm: 'stub', tts: 'stub', stt: 'stub', rendering: 'ffmpeg',
      storage: 'local', embeddings: 'stub', images: 'none', search: 'test',
    }),
    workspace: new SharedVolumeWorkspace(root),
    signal: new AbortController().signal,
    reportProgress: noop,
    throwIfCancelled: noop,
  } as unknown as PipelineContext;
}

const uploaded: ValidatedInput = {
  sources: [{
    sourceId: 'up-1',
    origin: { type: 'file', filename: 'notes.pdf', mimeType: 'application/pdf', bytes: 10 },
    sniffedMimeType: 'application/pdf',
  }],
};

/**
 * The whole design is that research produces *sources*, not answers. Asking a
 * model what it knows and writing that into the script produces a video whose
 * claims have no source — the one thing FR-9 exists to prevent. A URL goes
 * through the same door as an upload and is cited the same way.
 */
describe('ResearchTopicStage', () => {
  it('does nothing at all when research is off', async () => {
    const search = searchReturning([page('https://example.com/a')]);
    const stage = new ResearchTopicStage(search, plannerReturning(['q']));

    const result = await stage.execute(uploaded, await contextFor('none'));

    expect(result).toBe(uploaded);
    expect(search.queries).toHaveLength(0);
  });

  it('appends what it finds as ordinary URL sources', async () => {
    const stage = new ResearchTopicStage(
      searchReturning([page('https://example.com/a'), page('https://example.com/b')]),
      plannerReturning(['stomata gas exchange']),
    );

    const result = await stage.execute(uploaded, await contextFor('web_search', { direction: 'stomata' }));

    expect(result.sources).toHaveLength(3);
    expect(result.sources[1]).toMatchObject({
      origin: { type: 'url', url: 'https://example.com/a' },
      sniffedMimeType: 'text/html',
    });
    // The caller's own material is still first, and untouched.
    expect(result.sources[0]).toBe(uploaded.sources[0]);
  });

  /** web_search is one round. deep is what re-enters the loop. */
  it('searches once for web_search and twice for deep', async () => {
    const shallow = searchReturning([page('https://example.com/a')]);
    await new ResearchTopicStage(shallow, plannerReturning(['q1'], ['q2']))
      .execute(uploaded, await contextFor('web_search', { direction: 'x' }));
    expect(shallow.queries).toEqual(['q1']);

    const deep = searchReturning([page('https://example.com/a')], [page('https://example.com/b')]);
    await new ResearchTopicStage(deep, plannerReturning(['q1'], ['q2']))
      .execute(uploaded, await contextFor('deep', { direction: 'x' }));
    expect(deep.queries).toEqual(['q1', 'q2']);
  });

  /** Otherwise `deep` is just the same search run twice. */
  it('shows a later round what the first one already found', async () => {
    const planner = plannerReturning(['q1'], ['q2']);
    await new ResearchTopicStage(
      searchReturning([page('https://example.com/a', 'Stomata explained')]),
      planner,
    ).execute(uploaded, await contextFor('deep', { direction: 'x' }));

    expect(planner.prompts[0]).not.toContain('Already found');
    expect(planner.prompts[1]).toContain('Stomata explained');
  });

  it('does not ingest the same page twice', async () => {
    const stage = new ResearchTopicStage(
      searchReturning([page('https://example.com/a')], [page('https://example.com/a')]),
      plannerReturning(['q1'], ['q2']),
    );

    const result = await stage.execute(uploaded, await contextFor('deep', { direction: 'x' }));
    expect(result.sources).toHaveLength(2);
  });

  /**
   * Six good pages is a reading list; thirty is a search results page, and its
   * citations are ones nobody will check.
   */
  it('stops at the configured source ceiling', async () => {
    const stage = new ResearchTopicStage(
      searchReturning([1, 2, 3, 4, 5, 6, 7, 8].map((n) => page(`https://example.com/${n}`))),
      plannerReturning(['q1']),
    );

    const result = await stage.execute(uploaded, await contextFor('web_search', {
      direction: 'x',
      limits: { maxRounds: 1, queriesPerRound: 1, maxSources: 3 },
    }));

    expect(result.sources).toHaveLength(1 + 3);
  });

  /**
   * The caller's own material is still there, and a video built from it is worth
   * more than an error about a search engine.
   */
  it('survives a search engine that is down', async () => {
    const broken: WebSearchPort = {
      name: 'broken',
      async search() { throw new Error('search is down'); },
    };

    const result = await new ResearchTopicStage(broken, plannerReturning(['q1']))
      .execute(uploaded, await contextFor('web_search', { direction: 'x' }));

    expect(result.sources).toEqual(uploaded.sources);
  });

  it('falls back to the topic itself when the planner is unavailable', async () => {
    const search = searchReturning([page('https://example.com/a')]);
    const brokenPlanner: LlmClientPort = {
      modelFor: () => 'stub',
      async generate() { throw new Error('model is down'); },
    };

    await new ResearchTopicStage(search, brokenPlanner)
      .execute(uploaded, await contextFor('web_search', { direction: 'photosynthesis' }));

    expect(search.queries).toEqual(['photosynthesis']);
  });

  it('does not search for the empty string when there is nothing to research', async () => {
    const search = searchReturning([page('https://example.com/a')]);

    const result = await new ResearchTopicStage(search, plannerReturning(['q']))
      .execute({ sources: [] }, await contextFor('web_search'));

    expect(search.queries).toHaveLength(0);
    expect(result.sources).toHaveLength(0);
  });

  /** Grounded search is billed per request, so it cannot ride along in token usage. */
  it('meters its searches separately from its tokens', async () => {
    const ctx = await contextFor('web_search', { direction: 'x' });
    await new ResearchTopicStage(
      searchReturning([page('https://example.com/a')]),
      plannerReturning(['q1', 'q2']),
    ).execute(uploaded, ctx);

    const cost = ctx.costMeter.snapshot(60).toJSON() as { units?: Record<string, number> };
    expect(cost.units?.['search_queries']).toBe(2);
  });
});

/**
 * Asked a question it already knows, the model answers from memory and returns
 * no grounding at all — verified against the live API. The instruction to search
 * is what makes this a search engine rather than a chat.
 */
describe('GeminiGroundedSearch', () => {
  const search = () => new GeminiGroundedSearch({
    apiKey: 'k', model: 'test-model', requestTimeoutMs: 5000, baseUrl: 'https://gen.example',
  }, logger);

  it('tells the model to search, and keeps only the URLs', async () => {
    const seen: any[] = [];
    vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({
        candidates: [{
          content: { parts: [{ text: 'a long prose answer nobody asked for' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://redirect.example/1', title: 'nih.gov' } },
              { web: { uri: 'https://redirect.example/2', title: 'britannica.com' } },
            ],
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const hits = await search().search({ query: 'stomata', limit: 5 });

    expect(seen[0].tools).toEqual([{ google_search: {} }]);
    expect(seen[0].contents[0].parts[0].text).toContain('Use the search tool');
    expect(hits.map((hit) => hit.url)).toEqual([
      'https://redirect.example/1', 'https://redirect.example/2',
    ]);
    // The model's own answer is a claim with no source attached; it is dropped.
    expect(JSON.stringify(hits)).not.toContain('prose answer');
  });

  it('returns nothing when the model chose not to search', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'I know this already' }] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    expect(await search().search({ query: 'stomata', limit: 5 })).toEqual([]);
  });

  it('honours the limit', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      candidates: [{
        groundingMetadata: {
          groundingChunks: [1, 2, 3, 4].map((n) => ({ web: { uri: `https://e.example/${n}`, title: 'e' } })),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    expect(await search().search({ query: 'x', limit: 2 })).toHaveLength(2);
  });
});
