import type { ImageSourcePort } from '@application/port/ImageSourcePort.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';

/**
 * Which adapter serves which provenance, for the sources this deployment can
 * actually reach.
 *
 * Adapters register themselves and callers look them up by id, exactly as
 * `ExtractorRegistry` does for file formats — adding a sixth library is a new
 * file plus a registration, with no switch statement to edit. That is the
 * open/closed rule made concrete rather than asserted, and it is the specific
 * thing that was missing: the composite used to test `source.name ===
 * 'wikimedia'` to route diagram queries, so a new source could not be added
 * without editing the class whose whole job is to be indifferent to which
 * sources exist.
 *
 * **The registry is the deployment's capability, not the job's permission.** It
 * holds what has a credential; a job's `imageSources` says what it wants, and
 * the intersection is what gets asked. Keeping those two apart is what makes
 * "requested a source we have no key for" an ordinary outcome instead of an
 * error.
 */
export class ImageSourceRegistry {
  private readonly sources = new Map<ImageSourceId, ImageSourcePort>();

  public register(id: ImageSourceId, source: ImageSourcePort): this {
    this.sources.set(id, source);
    return this;
  }

  public resolve(id: ImageSourceId): ImageSourcePort | undefined {
    return this.sources.get(id);
  }

  /** What this deployment can reach. For the boot log, and for the intersection. */
  public get registered(): readonly ImageSourceId[] {
    return [...this.sources.keys()];
  }

  public get isEmpty(): boolean {
    return this.sources.size === 0;
  }
}
