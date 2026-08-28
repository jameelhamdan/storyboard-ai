/** Presets are data (config/presets.yaml); this is the validated shape. */
export type VideoCodec = 'h264' | 'h265' | 'vp9';

export class QualityPreset {
  private constructor(
    public readonly name: string,
    public readonly width: number,
    public readonly height: number,
    public readonly fps: number,
    public readonly codec: VideoCodec,
    public readonly crf: number,
  ) {}

  public static of(input: {
    name: string; width: number; height: number; fps: number; codec: VideoCodec; crf: number;
  }): QualityPreset {
    for (const [k, v] of Object.entries({ width: input.width, height: input.height, fps: input.fps })) {
      if (!Number.isInteger(v) || v <= 0) throw new RangeError(`Preset '${input.name}': ${k} must be a positive integer, got ${v}.`);
    }
    if (input.width % 2 !== 0 || input.height % 2 !== 0) {
      throw new RangeError(`Preset '${input.name}': H.264 requires even dimensions, got ${input.width}x${input.height}.`);
    }
    if (input.crf < 0 || input.crf > 51) throw new RangeError(`Preset '${input.name}': CRF must be 0-51, got ${input.crf}.`);
    return new QualityPreset(input.name, input.width, input.height, input.fps, input.codec, input.crf);
  }

  /** 1,440 at 720p24 — the number §11's render cost is built on. */
  public get framesPerVideoMinute(): number {
    return this.fps * 60;
  }

  public get resolution(): string {
    return `${this.width}x${this.height}`;
  }

  public get isPortrait(): boolean {
    return this.height > this.width;
  }
}
