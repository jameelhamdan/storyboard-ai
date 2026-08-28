import type {
  ImageSourcePort, IllustrationFinderPort, ImageQuery,
} from '@application/port/ImageSourcePort.js';
import type { SceneImage } from '@domain/media/SceneImage.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';
import type { ImageSourcePolicy } from '@domain/policy/ImageSourcePolicy.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import type { ImageSourceRegistry } from './ImageSourceRegistry.js';

/**
 * Asks the libraries a job allows, in the order the policy gives, and returns
 * the first real answer.
 *
 * Three rules, and none of them is about a particular vendor:
 *
 * **Order is a domain decision, taken elsewhere.** `ImageSourcePolicy` decides
 * that a diagram query starts at Commons and a photo query starts at the stock
 * libraries. This class used to decide it, with a `source.name === 'wikimedia'`
 * test, which meant a fifth source could not be added without editing the one
 * class that should not care how many there are.
 *
 * **What the job allows is intersected with what the deployment can reach.**
 * Asking for a library with no credential is an ordinary outcome, not an error;
 * it simply is not in the registry, so it is not asked.
 *
 * **One source failing must not lose the board.** A search that throws — expired
 * key, rate limit, CDN timeout — is logged and skipped. With three libraries
 * configured, two working is a working feature. Only "nobody found anything"
 * reaches the caller, as `undefined`, which is itself an ordinary answer: a
 * query with no good match is better served by a drawn board, and the caller
 * has one.
 *
 * Results are cached per process because scenes are illustrated concurrently and
 * a regenerated scene usually asks for the same picture again. The cache is
 * bounded: a data URI is a megabyte, and a long-lived worker would otherwise
 * hold every image it ever fetched.
 */
const MAX_CACHED = 32;

export class CompositeImageSource implements IllustrationFinderPort {
  private readonly cache = new Map<string, SceneImage | undefined>();

  constructor(
    private readonly registry: ImageSourceRegistry,
    private readonly policy: ImageSourcePolicy,
    private readonly logger: LoggerPort,
  ) {}

  public get available(): readonly ImageSourceId[] {
    return this.registry.registered;
  }

  public async find(query: ImageQuery): Promise<SceneImage | undefined> {
    const sources = this.sourcesFor(query);
    if (sources.length === 0) {
      this.logger.info(
        { query: query.query, kind: query.kind },
        'no image library is both configured and permitted for this job',
      );
      return undefined;
    }

    // The allowed set is part of the key: two jobs asking the same question with
    // different libraries permitted can legitimately get different pictures.
    const key = [
      query.kind,
      query.orientation ?? 'any',
      sources.map((source) => source.id).join(','),
      query.query.toLowerCase().trim(),
    ].join(':');
    if (this.cache.has(key)) return this.cache.get(key);

    for (const source of sources) {
      try {
        const found = await source.find(query);
        if (found) {
          this.remember(key, found);
          this.logger.info(
            { source: source.id, query: query.query, kind: query.kind },
            'illustration image found',
          );
          return found;
        }
      } catch (error) {
        this.logger.warn(
          { err: error, source: source.id, query: query.query },
          'image source failed; trying the next one',
        );
      }
    }

    // A negative result is cached too: the retry path asks the same question
    // again, and the answer will not have changed within one job.
    this.remember(key, undefined);
    this.logger.info({ query: query.query, kind: query.kind }, 'no image found for this scene');
    return undefined;
  }

  /**
   * Permitted by the job, reachable by the deployment, ordered by the policy.
   *
   * A query naming no sources falls back to everything registered — that is the
   * internal caller who has already resolved the job's list, not a caller
   * silently opting out of the job's choice.
   */
  private sourcesFor(query: ImageQuery): readonly ImageSourcePort[] {
    const requested = query.sources ?? this.registry.registered;
    const permitted = requested.filter((id) => this.registry.resolve(id) !== undefined);

    return this.policy
      .order(query.kind, permitted)
      .map((id) => this.registry.resolve(id))
      .filter((source): source is ImageSourcePort => source !== undefined);
  }

  private remember(key: string, image: SceneImage | undefined): void {
    if (this.cache.size >= MAX_CACHED) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, image);
  }
}
