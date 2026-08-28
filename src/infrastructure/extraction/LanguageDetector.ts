import { eld } from 'eld';
import { Language } from '@domain/shared/Language.js';

/**
 * Detection runs *per document*, not once over the merged body — a mixed upload
 * (Spanish slides plus an English paper) must stay correctly labelled chunk by
 * chunk, because detected language changes how each source is processed: STT
 * model hinting, OCR language packs, extraction prompts.
 */
export class LanguageDetector {
  public detect(text: string): Language | undefined {
    const sample = text.trim();
    // Short samples produce confident nonsense; better to return nothing and let
    // the caller fall back to the requested output language.
    if (sample.length < 40) return undefined;

    const result = eld.detect(sample);
    return Language.tryOf(result.language);
  }
}
