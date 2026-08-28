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
 * **Every entry is a picture that already exists.** This service finds images
 * and draws diagrams; it does not generate imagery with a model. A board is
 * either a diagram laid out by the renderer from a described `SceneDiagram`, or
 * a real photograph or published figure, credited to whoever made it. There is
 * deliberately no id for a generated image, so there is no way to ask for one.
 */
export const IMAGE_SOURCE_IDS = [
  'wikimedia',   // published scientific diagrams, freely licensed
  'unsplash',    // photographs
  'pexels',      // photographs, a second library
  'web_search',  // the open web, licence-filtered
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
