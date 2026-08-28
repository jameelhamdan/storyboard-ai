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
   * Commons first: a published scientific figure is what a diagram query wants,
   * and it is the only library that reliably has one. The stock libraries are
   * behind it because they will happily return a photograph of a laboratory for
   * "the Krebs cycle", and the open web is behind them because it is the only
   * source that cannot state a licence.
   */
  diagram: ['wikimedia', 'web_search', 'unsplash', 'pexels'],
  /**
   * Photographs are the other way round: the stock libraries are curated for
   * exactly this and Commons is not.
   */
  photo: ['unsplash', 'pexels', 'web_search', 'wikimedia'],
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
