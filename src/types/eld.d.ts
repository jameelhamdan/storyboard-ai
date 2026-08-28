/**
 * `eld` ships no types. The surface we use is one call, so a local declaration is
 * cheaper and more honest than pulling in an untyped `any`.
 */
declare module 'eld' {
  export interface EldResult {
    language: string;
    getScores(): Record<string, number>;
    isReliable(): boolean;
  }
  export const eld: {
    detect(text: string): EldResult;
    info(): Record<string, unknown>;
  };
}
