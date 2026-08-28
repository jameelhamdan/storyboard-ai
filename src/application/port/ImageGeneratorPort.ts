export interface GeneratedImage {
  readonly bytes: Buffer;
  readonly mimeType: string;
}

/**
 * Draws a picture to order.
 *
 * Deliberately narrower than "an image model": one call, a prompt, an optional
 * reference to work from, bytes back. Everything that makes the result *this
 * video's* picture — the palette, the stroke weight, the scene's concept — is
 * composed into the prompt by the caller, because that is knowledge about
 * boards and not about a vendor's API.
 *
 * The reference is the interesting parameter. A model asked for "a diagram of
 * the Krebs cycle" invents a plausible-looking one, labels included, and a
 * plausible-looking invented diagram is exactly the failure this service exists
 * to avoid. Given a real published figure to redraw, it is restyling something
 * that was already correct.
 */
export interface ImageGeneratorPort {
  /** The model's name, for the credit line and the cost report. */
  readonly model: string;

  generate(input: {
    prompt: string;
    /** What to redraw. Absent means drawing from the description alone. */
    reference?: GeneratedImage;
    signal?: AbortSignal;
  }): Promise<GeneratedImage>;
}
