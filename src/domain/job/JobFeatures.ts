import type { ImageSourceId } from '../media/ImageSourceId.js';

/**
 * The optional halves of the pipeline, per job.
 *
 * Both of these cost money and neither is always wanted: illustration searches
 * outside libraries and pastes a real photograph onto a hand-drawn board, and
 * the plan review spends a quality-tier call — sometimes two, plus a rewrite —
 * before a single scene is illustrated. A caller producing forty short videos
 * on a budget wants them off; a caller producing one video that a class will sit
 * through wants both.
 *
 * **A feature being on here means the caller asked for it, not that it will
 * happen.** Capability is separate and belongs to the composition root: with no
 * image library configured, `images: true` still yields drawn boards, because
 * the request expresses intent and the deployment decides what it can do. Those
 * two questions used to be one boolean and it was never clear which one a
 * `false` meant.
 */
export interface JobFeatureFlags {
  /**
   * Allow the `illustration` board: a found photograph or published diagram,
   * credited, instead of a drawn one.
   */
  readonly images: boolean;
  /**
   * Which libraries the illustrator may draw from, in the caller's own order of
   * preference — though `ImageSourcePolicy` still routes a diagram query away
   * from a stock library, because that is a judgement about the material rather
   * than a preference.
   *
   * Separate from `images` rather than replacing it. The boolean is the master
   * switch and reads clearly at a glance; the list is the detail. An empty list
   * means the same as `images: false`, and `images: false` wins over any list —
   * two ways of saying no, neither of which can contradict the other.
   */
  readonly imageSources: readonly ImageSourceId[];
  /**
   * Judge the whole story — scene set, order, shape per scene — before anything
   * is illustrated, and revise it if the judge objects.
   */
  readonly planReview: boolean;
}

export class JobFeatures {
  private constructor(private readonly flags: JobFeatureFlags) {}

  public static of(flags: JobFeatureFlags): JobFeatures {
    return new JobFeatures(flags);
  }

  /**
   * Applies a partial request over the deployment's defaults.
   *
   * `undefined` means "not stated" and inherits, which is what makes the
   * defaults in `config/default.yaml` meaningful — a request that mentions one
   * feature must not silently turn the other off.
   */
  public static resolve(
    defaults: JobFeatureFlags,
    requested: Partial<JobFeatureFlags> | undefined,
  ): JobFeatures {
    return new JobFeatures({
      images: requested?.images ?? defaults.images,
      imageSources: requested?.imageSources ?? defaults.imageSources,
      planReview: requested?.planReview ?? defaults.planReview,
    });
  }

  public get images(): boolean { return this.flags.images; }
  public get planReview(): boolean { return this.flags.planReview; }

  /**
   * The sources this job may use — empty whenever images are off, so a caller
   * of this getter never has to check the boolean as well. One question, one
   * answer.
   */
  public get imageSources(): readonly ImageSourceId[] {
    return this.flags.images ? this.flags.imageSources : [];
  }

  public toJson(): JobFeatureFlags {
    return {
      images: this.flags.images,
      imageSources: [...this.flags.imageSources],
      planReview: this.flags.planReview,
    };
  }

  /**
   * A checkpoint written before this field existed has no features on it, and a
   * job resumed from one must not change behaviour halfway through — so the
   * absent case takes the deployment's defaults rather than inventing `false`.
   */
  public static fromJson(
    json: Partial<JobFeatureFlags> | null | undefined,
    defaults: JobFeatureFlags,
  ): JobFeatures {
    return JobFeatures.resolve(defaults, json ?? undefined);
  }
}
