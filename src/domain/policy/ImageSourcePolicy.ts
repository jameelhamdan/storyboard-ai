import type { ImageSourceId } from '../media/ImageSourceId.js';

/** What the illustrator asked for. Photographs and diagrams live in different libraries. */
export type ImageKind = 'photo' | 'diagram';

/**
 * Which library to ask first, and the order to fall through.
 *
 * **Routing beats ranking, and it is a domain decision.** The libraries are not
 * interchangeable: Wikimedia Commons has the Krebs cycle and few good
 * photographs, and a stock search for the Krebs cycle returns a photograph of a
 * laboratory bench. Which source answers a question best is a fact about the
 * material, not about an HTTP client — so it lives here rather than in the
 * adapter that iterates them.
 *
 * It was in the adapter, as `source.name === 'wikimedia'`, and that was the
 * problem: a fifth source could not be added without editing the class whose
 * whole job is to be indifferent to which sources exist.
 *
 * The affinities below are preferences, not restrictions. Every allowed source
 * is still tried — a miss costs one search, and a photograph of the real object
 * is a better answer to a diagram query than no board at all.
 */
const AFFINITY: Readonly<Record<ImageKind, readonly ImageSourceId[]>> = Object.freeze({
  /**
   * Generated art leads for diagrams because a drawn explanation is what the
   * board wants and the generator can produce exactly the figure the scene
   * describes. Commons is next: a real published figure beats an invented one
   * whenever it exists, which is why generation does not simply replace it.
   */
  diagram: ['generated', 'wikimedia', 'web_search', 'unsplash', 'pexels'],
  /**
   * Photographs are the opposite: a real photograph of a real thing is the
   * point, and a generated one is a picture of something that does not exist.
   * It stays last rather than absent, so a subject the libraries have nothing
   * for still gets a board.
   */
  photo: ['unsplash', 'pexels', 'web_search', 'wikimedia', 'generated'],
});

export class ImageSourcePolicy {
  /**
   * The sources to try, in order.
   *
   * `allowed` is the job's own list and its order is honoured *within* an
   * affinity tier — a caller who lists `pexels` before `unsplash` gets Pexels
   * first, because they said so and both are equally suited. What the caller
   * cannot do by ordering alone is put a stock library ahead of Commons for a
   * diagram, which is the mistake this policy exists to prevent.
   */
  public order(kind: ImageKind, allowed: readonly ImageSourceId[]): readonly ImageSourceId[] {
    const permitted = new Set(allowed);
    const preference = AFFINITY[kind];

    return [...permitted].sort((a, b) => {
      const rank = preference.indexOf(a) - preference.indexOf(b);
      // Equal affinity is impossible with the tables above, but the caller's own
      // order is the right tiebreak if one is ever added.
      return rank !== 0 ? rank : allowed.indexOf(a) - allowed.indexOf(b);
    });
  }
}
