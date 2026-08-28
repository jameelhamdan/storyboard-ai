import type { TextNormalizerPort } from '@application/pipeline/stage/GenerateScriptStage.js';

/**
 * Rewrites narration into the form the synthesiser will actually speak.
 *
 * Runs at the *end* of script generation, before the storyboard sees the text —
 * so `data-on` anchors are matched against the same tokens the TTS word timings
 * come back keyed on. Running it later would silently break every anchor that
 * touched a numeral or a symbol.
 *
 * Deliberately conservative: it expands only what is unambiguous. A wrong
 * expansion is worse than none, because it changes what the video says.
 */
export class NarrationTextNormalizer implements TextNormalizerPort {
  private static readonly UNITS: Readonly<Record<string, readonly string[]>> = {
    en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
         'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
         'seventeen', 'eighteen', 'nineteen'],
    es: ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
         'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis',
         'diecisiete', 'dieciocho', 'diecinueve'],
  };

  private static readonly SYMBOLS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    en: { '%': ' percent', '&': ' and ', '+': ' plus ', '=': ' equals ', '×': ' times ', '÷': ' divided by ', '°': ' degrees' },
    es: { '%': ' por ciento', '&': ' y ', '+': ' más ', '=': ' es igual a ', '×': ' por ', '÷': ' dividido por ', '°': ' grados' },
  };

  private static readonly ABBREVIATIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    en: { 'fig.': 'figure', 'eq.': 'equation', 'e.g.': 'for example', 'i.e.': 'that is', 'etc.': 'et cetera', 'vs.': 'versus', 'approx.': 'approximately' },
    es: { 'fig.': 'figura', 'ec.': 'ecuación', 'p.ej.': 'por ejemplo', 'es decir': 'es decir', 'etc.': 'etcétera' },
  };

  public normalize(text: string, language: string): string {
    const lang = language in NarrationTextNormalizer.UNITS ? language : 'en';
    let output = text;

    output = this.expandAbbreviations(output, lang);
    output = this.expandSymbols(output, lang);
    output = this.expandNumbers(output, lang);

    return output.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
  }

  private expandAbbreviations(text: string, lang: string): string {
    const table = NarrationTextNormalizer.ABBREVIATIONS[lang] ?? {};
    let output = text;

    for (const [abbreviation, expansion] of Object.entries(table)) {
      const escaped = abbreviation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      output = output.replace(new RegExp(`\\b${escaped}`, 'gi'), expansion);
    }
    return output;
  }

  private expandSymbols(text: string, lang: string): string {
    const table = NarrationTextNormalizer.SYMBOLS[lang] ?? {};
    let output = text;

    for (const [symbol, expansion] of Object.entries(table)) {
      output = output.split(symbol).join(expansion);
    }
    return output;
  }

  /**
   * Only integers below 20 and round thousands are expanded. Decimals, years,
   * versions, and long identifiers are left alone: TTS engines already read those
   * sensibly, and getting them wrong is more damaging than leaving them.
   */
  private expandNumbers(text: string, lang: string): string {
    const units = NarrationTextNormalizer.UNITS[lang] ?? NarrationTextNormalizer.UNITS['en']!;

    /**
     * Both sides must be guarded. The lookahead alone protects the `3` in
     * `3.14` but not the `14`, which would be read as "three point fourteen";
     * the lookbehind catches the trailing half of a decimal, ratio or date.
     */
    return text.replace(/(?<![\d.:/-])\b(\d{1,2})\b(?!\s*[.:/-]\s*\d)/g, (whole, digits: string) => {
      const value = Number(digits);
      return value < units.length ? (units[value] ?? whole) : whole;
    });
  }
}
