/**
 * Where a board's picture may come from.
 *
 * These are **provenance identities, not vendor bindings**. Each one already
 * appears in the credit line under the picture — `SceneImage.attribution` names
 * Wikimedia Commons, Unsplash or Pexels because the licence requires it — so the
 * set of possible provenances is a fact about the finished video, which is
 * exactly what belongs in the domain. The adapters that talk to those services
 * stay in infrastructure and are resolved by id at the composition root.
 *
 * `generated` is the odd one and is deliberately in the same vocabulary: an
 * AI-drawn illustration is a *different provenance*, credited differently, and a
 * caller who is willing to accept a stock photograph but not a generated image
 * needs a way to say so. Modelling it as a source rather than a flag is what
 * makes that expressible.
 */
export const IMAGE_SOURCE_IDS = [
  'wikimedia',   // published scientific diagrams, freely licensed
  'unsplash',    // photographs
  'pexels',      // photographs, a second library
  'web_search',  // the open web, licence-filtered
  'generated',   // drawn to order from a reference, credited as AI-generated
] as const;

export type ImageSourceId = (typeof IMAGE_SOURCE_IDS)[number];

/**
 * An unknown id is a caller error, and is rejected at the edge with a 400 that
 * lists the valid values (`generateRequestSchema`) rather than being dropped
 * here. The distinction matters: asking for a source this deployment has no
 * *credential* for is ordinary and silently yields the intersection, while
 * asking for a source that does not *exist* is a typo the caller needs told
 * about. Only the second is an error.
 */
