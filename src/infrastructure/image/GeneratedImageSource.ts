import type { ImageSourcePort, IllustrationFinderPort, ImageQuery } from '@application/port/ImageSourcePort.js';
import type { ImageGeneratorPort } from '@application/port/ImageGeneratorPort.js';
import type { SceneImage } from '@domain/media/SceneImage.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';
import { inlineImage } from './inlineImage.js';

export interface GeneratedImageOptions {
  /**
   * The look every generated board shares, composed from the theme at the
   * composition root: palette, stroke weight, background. Passed in rather than
   * read here because a source knows nothing about themes — and because two
   * deployments with different themes must not produce the same drawing.
   */
  readonly styleBrief: string;
}

/**
 * A drawing made to order — from a real reference wherever one exists.
 *
 * **The reference is the point.** Asked for "a diagram of the Krebs cycle" with
 * nothing to work from, an image model invents a plausible-looking one, labels
 * included, and a plausible-looking invented diagram is precisely the failure
 * this service exists to avoid. So this source searches first, hands the model a
 * published figure to redraw in the video's own style, and only draws from the
 * description alone when nothing was found.
 *
 * **It is a source, not a mode.** Modelling generation as another
 * `ImageSourcePort` — rather than a flag on the finder, or a branch inside the
 * composite — is what lets a caller order it, permit it, or refuse it exactly
 * like Unsplash, and lets the ordering policy prefer it for diagrams and avoid
 * it for photographs. Nothing else in the pipeline needed changing to add it.
 *
 * **A failed generation ships the reference.** The photograph was already found
 * and already correct; returning `undefined` would send the composite off to
 * search the same libraries a second time for a worse answer. Losing the
 * restyle costs the video some coherence, and losing the board costs it a scene.
 */
export class GeneratedImageSource implements ImageSourcePort {
  public readonly id: ImageSourceId = 'generated';

  constructor(
    private readonly generator: ImageGeneratorPort,
    private readonly options: GeneratedImageOptions,
    private readonly logger: LoggerPort,
    /**
     * Where the reference comes from. Absent is legitimate — a deployment with
     * an image model and no libraries draws from descriptions — and is not the
     * same as a search that found nothing.
     */
    private readonly references?: IllustrationFinderPort,
  ) {}

  public async find(query: ImageQuery): Promise<SceneImage | undefined> {
    const reference = await this.reference(query);

    try {
      const drawn = await this.generator.generate({
        prompt: this.promptFor(query, reference !== undefined),
        ...(reference ? { reference: bytesOf(reference) } : {}),
        ...(query.signal ? { signal: query.signal } : {}),
      });

      return await inlineImage({
        bytes: drawn.bytes,
        alt: reference?.alt || query.query,
        /**
         * Credited as generated, always.
         *
         * An AI drawing that reads as a photograph is the one dishonesty
         * available here, and `SceneImage` will not exist without a credit — so
         * the only question is whether the credit tells the truth. When it was
         * drawn from someone's photograph, they are named too: the derivative
         * work does not stop being derived from their picture.
         */
        attribution: {
          author: 'Generated',
          sourceName: this.generator.model,
          sourceUrl: reference?.attribution.sourceUrl ?? '',
          licence: reference
            ? `AI-generated from ${reference.attribution.author} / ${reference.attribution.sourceName}`
            : 'AI-generated',
        },
        source: 'generated',
      });
    } catch (error) {
      this.logger.warn(
        { err: error, query: query.query, hadReference: reference !== undefined },
        reference
          ? 'image generation failed; shipping the reference image as found'
          : 'image generation failed and there was no reference to fall back to',
      );
      return reference;
    }
  }

  /** The search that grounds the drawing. Never fatal — drawing blind is worse, not impossible. */
  private async reference(query: ImageQuery): Promise<SceneImage | undefined> {
    if (!this.references) return undefined;
    try {
      // `sources` is dropped deliberately: the caller permitted `generated`, and
      // what this consults to ground it is an implementation detail of drawing —
      // not a second choice for them to make. The inner finder is built over the
      // searchable libraries only, so this cannot recurse.
      return await this.references.find({
        query: query.query,
        kind: query.kind,
        ...(query.orientation ? { orientation: query.orientation } : {}),
        ...(query.signal ? { signal: query.signal } : {}),
      });
    } catch (error) {
      this.logger.warn({ err: error, query: query.query }, 'reference search failed; drawing without one');
      return undefined;
    }
  }

  private promptFor(query: ImageQuery, hasReference: boolean): string {
    return [
      hasReference
        ? 'Redraw the attached image as a hand-drawn whiteboard illustration.'
        : `Draw a hand-drawn whiteboard illustration of: ${query.query}.`,
      hasReference
        ? 'Keep every structure, proportion and spatial relationship exactly as the reference shows them —'
          + ' you are restyling a correct picture, not composing a new one.'
        : 'Draw only what is certain about the subject; leave out any detail you would have to invent.',
      // Labels are the renderer's job: it lays out callouts as HTML beside the
      // plate, where they wrap, meet the legibility floor and get measured.
      // Baked-in text does none of that and cannot be checked.
      'No text, no labels, no numbers, no arrows carrying words. The picture only.',
      'A single subject on a plain background, with generous empty space around it.',
      this.options.styleBrief,
      ...(query.styleNote ? [`This scene is about: ${query.styleNote}`] : []),
    ].join('\n');
  }
}

/**
 * Back from an inlined data URI to bytes.
 *
 * Slightly wasteful — the source decoded, resized and re-encoded these bytes on
 * the way in — but it keeps `ImageSourcePort` returning one type. The
 * alternative is a second port returning raw bytes that only this class would
 * ever call, and a resized reference is what should be sent anyway: a 4MB
 * original costs input tokens for detail the model does not need.
 */
function bytesOf(image: SceneImage): { bytes: Buffer; mimeType: string } {
  const [, mimeType = 'image/webp', base64 = ''] = /^data:([^;]+);base64,(.*)$/.exec(image.dataUri) ?? [];
  return { bytes: Buffer.from(base64, 'base64'), mimeType };
}
