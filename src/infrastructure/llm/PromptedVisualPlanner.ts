import type { LlmClientPort } from '@application/port/LlmClientPort.js';
import type { VisualPlannerPort, VisualPlanResult } from '@application/port/VisualPlannerPort.js';
import type { NarrationScript } from '@domain/script/NarrationScript.js';
import type { Language } from '@domain/shared/Language.js';
import { VisualPlan } from '@domain/media/VisualPlan.js';
import type { PromptLibrary } from './PromptLibrary.js';

interface PlanResponse {
  readonly palette?: {
    readonly ground?: string; readonly ink?: string;
    readonly accents?: string[]; readonly muted?: string;
  };
  readonly scenes?: { sceneIndex?: number; concept?: string; emphasis?: string[] }[];
}

const planSchema = {
  type: 'object',
  properties: {
    palette: {
      type: 'object',
      properties: {
        ground: { type: 'string', description: 'Six-digit hex, e.g. #FAFAF8' },
        ink: { type: 'string', description: 'Six-digit hex' },
        accents: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
        muted: { type: 'string', description: 'Six-digit hex' },
      },
      required: ['ground', 'ink', 'accents', 'muted'],
    },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sceneIndex: { type: 'integer' },
          concept: { type: 'string' },
          emphasis: { type: 'array', items: { type: 'string' } },
        },
        required: ['sceneIndex', 'concept', 'emphasis'],
      },
    },
  },
  required: ['palette', 'scenes'],
};

/**
 * Quality tier: this runs once per video and every scene inherits its output, so
 * a bad palette is not a bad scene — it is a bad video. That is worth the more
 * expensive model, and it is one call regardless of scene count.
 */
export class PromptedVisualPlanner implements VisualPlannerPort {
  constructor(
    private readonly client: LlmClientPort,
    private readonly prompts: PromptLibrary,
  ) {}

  public async plan(input: {
    script: NarrationScript;
    outputLanguage: Language;
    subject: string;
    /** The style's visual sentence — how dense the boards should be. */
    styleNote: string;
    /** The caller's free-text steer, already bounded and cleaned. */
    direction?: string;
    signal?: AbortSignal;
  }): Promise<VisualPlanResult> {
    const prompt = this.prompts.render('08-visual-plan', {
      language: input.outputLanguage.code,
      style: input.styleNote,
      direction: input.direction ?? 'none',
      scenes: input.script.scenes
        .map((s) => `### Scene ${s.index}\n${s.writtenText}`)
        .join('\n\n'),
    });

    const result = await this.client.generate<PlanResponse>({
      system: prompt.system,
      user: prompt.user,
      tier: 'quality',
      responseSchema: planSchema as unknown as Record<string, unknown>,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const palette = result.parsed?.palette;
    if (!palette?.ground || !palette.ink || !palette.muted || !palette.accents?.length) {
      throw new Error('Visual planner returned no usable palette.');
    }

    // `VisualPlan.of` validates hex and the contrast floor and throws on a
    // palette nobody could read. The stage catches that and falls back to the
    // theme, so an unreadable design costs coherence rather than the job.
    const plan = VisualPlan.of({
      palette: {
        ground: normaliseHex(palette.ground),
        ink: normaliseHex(palette.ink),
        muted: normaliseHex(palette.muted),
        accents: palette.accents.map(normaliseHex),
      },
      scenes: (result.parsed?.scenes ?? [])
        .filter((s): s is { sceneIndex: number; concept: string; emphasis?: string[] } =>
          typeof s.sceneIndex === 'number' && typeof s.concept === 'string')
        .map((s) => ({
          sceneIndex: s.sceneIndex,
          concept: s.concept.trim(),
          emphasis: (s.emphasis ?? []).map((e) => e.trim()).filter(Boolean),
        })),
    });

    return { plan, usage: result.usage };
  }
}

/**
 * Models write colours in whatever form the prompt's examples suggested.
 * Accepting `FAFAF8` and `#faf` costs three lines and avoids discarding an
 * otherwise good palette over punctuation.
 */
function normaliseHex(value: string): string {
  const trimmed = value.trim().replace(/^#/, '');
  const expanded = trimmed.length === 3
    ? trimmed.split('').map((c) => c + c).join('')
    : trimmed;
  return `#${expanded.toUpperCase()}`;
}
