import type { SceneImage } from '@domain/media/SceneImage.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';
import type { ImageKind } from '@domain/policy/ImageSourcePolicy.js';

/**
 * What the illustrator is looking for.
 *
 * `kind` is the interesting field. A photograph and a published scientific
 * diagram are found in different places — stock libraries have beautiful
 * pictures of laboratories and nothing at all of the Krebs cycle, and Wikimedia
 * has the Krebs cycle and very few beautiful pictures — so routing by what is
 * actually wanted is the difference between finding the right image and finding
 * a stock photo of a scientist looking at a beaker.
 */
export interface ImageQuery {
  readonly query: string;
  readonly kind: ImageKind;
  readonly orientation?: 'landscape' | 'portrait' | 'square';
  /**
   * The provenances acceptable for *this* query — the job's own list.
   *
   * On the query rather than on the source because it is part of what is being
   * asked for: a caller who will take a stock photograph but not a generated
   * image is describing an acceptable answer, not configuring a client. A single
   * adapter has no use for it; the composite reads it, intersects it with what
   * the deployment can reach, and asks only those.
   */
  readonly sources?: readonly ImageSourceId[];
  /**
   * What this scene's picture is meant to convey, in the words the visual plan
   * used. Ignored by a library that can only search for keywords; used by a
   * source that *draws*, where it is the difference between a generic diagram
   * and this scene's diagram.
   */
  readonly styleNote?: string;
  readonly signal?: AbortSignal;
}

/**
 * Finds an existing image rather than drawing one.
 *
 * The port returns a finished `SceneImage` — searched, fetched, resized and
 * inlined — instead of a URL, because every caller wants the same four steps and
 * a URL is the one form the renderer cannot use. The work is per adapter so a
 * source with its own thumbnail rules or its own download-tracking requirement
 * (Unsplash has both) can satisfy them without the pipeline knowing.
 *
 * `undefined` means "nothing suitable", which is an ordinary answer and not an
 * error: a query with no good match is better served by a drawn board, and the
 * caller has one.
 */
export interface ImageSourcePort {
  /**
   * Which provenance this source produces.
   *
   * A domain id rather than a free-text vendor name: it appears in the credit
   * line, it is what a request names, and it is what the ordering policy sorts.
   */
  readonly id: ImageSourceId;
  find(query: ImageQuery): Promise<SceneImage | undefined>;
}

/**
 * Finds the one image a board should carry, from whichever libraries the job
 * allows.
 *
 * Separate from `ImageSourcePort` because it is a different responsibility, not
 * a bigger one: a source knows how to search *its* library, and a finder knows
 * which libraries to ask, in what order, what to do when one is down, and what
 * to remember. Collapsing them would give every adapter a routing policy it has
 * no use for.
 *
 * It is what the illustrator depends on, so a decorator — generating a drawing
 * from whatever was found, say — is a new implementation of this interface and
 * nothing else changes.
 */
export interface IllustrationFinderPort {
  /** For the boot log: which libraries are actually reachable. */
  readonly available: readonly ImageSourceId[];
  find(query: ImageQuery): Promise<SceneImage | undefined>;
}
