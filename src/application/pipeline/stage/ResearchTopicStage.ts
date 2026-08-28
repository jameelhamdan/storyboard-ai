import { randomUUID } from 'node:crypto';
import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import type { WebSearchPort, SearchHit } from '../../port/WebSearchPort.js';
import type { LlmClientPort } from '../../port/LlmClientPort.js';
import type { ValidatedInput } from './types.js';

/**
 * The queries a round runs, and what a later round still needs.
 */
interface ResearchResponse {
  queries?: string[];
}

/**
 * Searches the web for the topic and hands the results to ingestion as ordinary
 * URL sources.
 *
 * **It reads nothing itself.** The stage produces URLs; `IngestSourcesStage`
 * fetches them through `WebPageExtractor`, which goes through `SafeHttpClient`
 * — the SSRF guard genuinely applies here, since these URLs come from a search
 * engine rather than from us. Everything downstream is untouched: the pages are
 * chunked with provenance, ranked by `SourcePrecedencePolicy` as `web_page`,
 * and cited exactly like an uploaded PDF.
 *
 * That reuse is the entire design. The alternative — asking a model what it
 * knows about the topic and writing that into the script — produces a video
 * whose claims have no source, which is the one thing FR-9 exists to prevent.
 * Researched material is *material*, and it enters through the same door as
 * everything else.
 *
 * **Where it sits.** Between `validate` and `ingest`, because it appends to the
 * source list and everything after ingestion is indifferent to where a source
 * came from.
 *
 * **`web_search` searches once; `deep` re-enters the loop.** The second round is
 * asked what the first did not answer, which is a real capability and a real
 * bill — so it is a mode the caller selects rather than a threshold something
 * crosses.
 */
export class ResearchTopicStage implements PipelineStage<ValidatedInput, ValidatedInput> {
  public readonly name: StageName = 'research';

  constructor(
    private readonly search: WebSearchPort,
    /** Plans the queries, and — in `deep` mode — decides what is still missing. */
    private readonly llm: LlmClientPort,
  ) {}

  public async execute(input: ValidatedInput, ctx: PipelineContext): Promise<ValidatedInput> {
    const mode = ctx.job.features.research;
    const policy = ctx.config.policies.research;
    const rounds = policy.roundsFor(mode);

    if (rounds === 0) return input;

    const topic = ctx.job.direction?.text ?? '';
    if (!topic && input.sources.length === 0) {
      // Nothing to research *about*: no uploaded material to read and no
      // direction saying what the video is for. Better to say so than to search
      // for the empty string.
      ctx.logger.warn('research is enabled but the job supplied neither sources nor a direction');
      return input;
    }

    const seen = new Set<string>();
    const found: SearchHit[] = [];

    for (let round = 0; round < rounds; round += 1) {
      ctx.throwIfCancelled();

      const remaining = policy.remainingSources(found.length);
      if (remaining === 0) break;

      const queries = await this.queriesFor(topic, found, round, ctx);
      if (queries.length === 0) break;

      for (const query of queries) {
        if (found.length >= policy.remainingSources(0)) break;
        try {
          const hits = await this.search.search({
            query,
            limit: policy.remainingSources(found.length),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });

          for (const hit of hits) {
            if (seen.has(hit.url) || found.length >= policy.remainingSources(0)) continue;
            seen.add(hit.url);
            found.push(hit);
          }
        } catch (error) {
          // One failed query must not lose the round, and a failed round must
          // not lose the job: the caller's own material is still there, and a
          // video from it is worth more than an error about a search engine.
          ctx.logger.warn({ err: error, query }, 'a research query failed; continuing');
        }
      }

      ctx.costMeter.recordSearch(this.name, queries.length);
    }

    if (found.length === 0) {
      ctx.logger.warn({ mode }, 'research found no usable sources');
      return input;
    }

    ctx.logger.info(
      { mode, sources: found.length, hosts: found.map((hit) => hostOf(hit.url)) },
      'research added sources',
    );

    return {
      sources: [
        ...input.sources,
        ...found.map((hit) => ({
          sourceId: randomUUID(),
          origin: { type: 'url' as const, url: hit.url },
          // The extractor matches on origin, not on type, and the real content
          // type is settled when the page is actually fetched.
          sniffedMimeType: 'text/html',
        })),
      ],
    };
  }

  /**
   * What to search for.
   *
   * The first round turns the topic into search queries. A later round is shown
   * what has already been found and asked what is still missing — which is the
   * only thing that makes `deep` different from running the same search twice.
   */
  private async queriesFor(
    topic: string,
    found: readonly SearchHit[],
    round: number,
    ctx: PipelineContext,
  ): Promise<readonly string[]> {
    const policy = ctx.config.policies.research;

    const system = 'You plan web searches for an educational video. '
      + 'Return search queries only — no explanations, no questions to the user.';

    const user = round === 0
      ? `The video is about: ${topic || 'the material the student supplied'}.\n`
        + `Give up to ${policy.queriesPerRound} search queries that would find authoritative `
        + 'teaching material about it. Prefer specific queries over broad ones.'
      : `The video is about: ${topic}.\n`
        + `Already found:\n${found.map((hit) => `- ${hit.title}`).join('\n')}\n\n`
        + `Give up to ${policy.queriesPerRound} further queries for what these do not cover. `
        + 'Return nothing if the material already looks complete.';

    try {
      const result = await this.llm.generate<ResearchResponse>({
        system,
        user,
        // Volume tier: this is a list of search strings, checked by whether the
        // searches return anything, not a judgement about a student's material.
        tier: 'volume',
        responseSchema: {
          type: 'object',
          properties: { queries: { type: 'array', items: { type: 'string' } } },
          required: ['queries'],
        },
        maxOutputTokens: 1024,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      ctx.costMeter.recordTokens(this.name, result.usage);

      return (result.parsed?.queries ?? [])
        .map((query) => query.trim())
        .filter(Boolean)
        .slice(0, policy.queriesPerRound);
    } catch (error) {
      ctx.logger.warn({ err: error, round }, 'could not plan research queries');
      // The topic itself is a serviceable query when the planner is unavailable.
      return round === 0 && topic ? [topic] : [];
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}
