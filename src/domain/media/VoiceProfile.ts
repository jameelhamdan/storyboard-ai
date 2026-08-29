import type { Language } from '../shared/Language.js';

export type VoiceGender = 'female' | 'male';

/**
 * The slot is ours and stable; the provider voice id behind it comes from .env
 * as a VOICE_EN_FEMALE_1 style key, so swapping a voice never touches code.
 */
export class VoiceProfile {
  private constructor(
    public readonly slot: string,
    public readonly language: Language,
    public readonly gender: VoiceGender,
    public readonly providerVoiceId: string,
    public readonly label: string,
  ) {}

  public static of(input: {
    slot: string; language: Language; gender: VoiceGender; providerVoiceId: string; label?: string;
  }): VoiceProfile {
    if (!input.providerVoiceId) {
      throw new Error(`Voice slot '${input.slot}' has no provider voice id — check its .env key.`);
    }
    return new VoiceProfile(
      input.slot, input.language, input.gender, input.providerVoiceId,
      input.label ?? input.slot,
    );
  }

  public matchesLanguage(language: Language): boolean {
    return this.language.equals(language);
  }
}
