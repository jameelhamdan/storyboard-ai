/**
 * Adding a language is a config change (plan.md §12) — this list and the request
 * schema enum are the only code-side touchpoints, and both are data.
 */
export const SUPPORTED_LANGUAGES = ['en', 'es'] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];

export class Language {
  private constructor(public readonly code: LanguageCode) {}

  public static of(code: string): Language {
    const normalised = code.trim().toLowerCase().split(/[-_]/)[0] ?? '';
    if (!Language.isSupported(normalised)) {
      throw new RangeError(`Unsupported language '${code}'. Supported: ${SUPPORTED_LANGUAGES.join(', ')}.`);
    }
    return new Language(normalised);
  }

  /** Detection returns something we may not support; callers decide what to do. */
  public static tryOf(code: string | undefined | null): Language | undefined {
    if (!code) return undefined;
    try {
      return Language.of(code);
    } catch {
      return undefined;
    }
  }

  public static isSupported(code: string): code is LanguageCode {
    return (SUPPORTED_LANGUAGES as readonly string[]).includes(code);
  }

  public equals(other: Language): boolean {
    return this.code === other.code;
  }

  public toString(): string {
    return this.code;
  }
}
