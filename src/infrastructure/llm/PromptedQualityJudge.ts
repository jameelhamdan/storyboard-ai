import { readFile } from 'node:fs/promises';
import type { QualityJudgePort, SceneJudgement } from '@application/port/QualityJudgePort.js';
import type { Scene } from '@domain/script/Scene.js';
import type { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import { GATES, HolisticScore, type GateResult } from '@domain/quality/QualityScore.js';
import type { LlmClientPort } from '@application/port/LlmClientPort.js';
import type { PromptLibrary } from './PromptLibrary.js';
import { sceneJudgeSchema } from './schemas.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';

interface SceneJudgeResponse {
  gates: Record<string, { passed: boolean; note?: string } | undefined>;
  holistic: number;
}

/**
 * Stage B: one vision call per scene attempt, on the quality tier.
 *
 * There is no Stage C. A whole-video pass existed and was deleted — it ran
 * before the subtitles stage with an empty frame list and an empty cue list, so
 * it produced a score from the prompt text alone, at full price. The docstring
 * here claimed both stages long after only one was left.
 *
 * The tier is deliberate and it is the expensive choice: this reads a screenshot
 * and decides whether the board says what the narration says, which is the
 * hardest perceptual call in the pipeline and the gate on every board. What
 * keeps it affordable is that it is no longer asked about anything measurable —
 * overlap, clipping and text size are answered from the laid-out page before
 * this is called, and a scene failing them never reaches the model at all.
 */
export class PromptedQualityJudge implements QualityJudgePort {
  constructor(
    private readonly client: LlmClientPort,
    private readonly prompts: PromptLibrary,
    private readonly logger: LoggerPort,
  ) {}

  public async judgeScene(input: {
    scene: Scene;
    content: ConsolidatedContent;
    screenshotPaths: readonly string[];
    plannedConcept?: string;
    signal?: AbortSignal;
  }): Promise<SceneJudgement> {
    const prompt = this.prompts.render('03-scene-judge', {
      narration: input.scene.spokenText,
      html: input.scene.html ?? '',
      planned_concept: input.plannedConcept
        ?? '(no design brief was recorded for this scene)',
      source: input.scene.citations
        .map((c) => c.quote ?? c.refs.map((r) => r.key).join(', '))
        .join('\n'),
    });

    const images = await this.readImages(input.screenshotPaths);

    const result = await this.client.generate<SceneJudgeResponse>({
      system: prompt.system,
      user: prompt.user,
      /**
       * Quality tier, despite grading our own output.
       *
       * The two-tier rule — cheap model grades, expensive model reads the
       * student's material — was written when grading meant reading markup.
       * It now means looking at a *screenshot* and deciding whether the board
       * reads: whether the focal point is obvious, whether labels collide,
       * whether the drawing actually says what the narration says. That is the
       * hardest perceptual call in the pipeline.
       *
       * It is also the gate on every board. A judge that cannot see well passes
       * bad diagrams, which caps visual quality no matter how good the
       * storyboard model is — and the cost is small, because the judge reads an
       * image and writes a verdict: ~300 output tokens against the
       * storyboard's ~2,200.
       */
      tier: 'quality',
      responseSchema: sceneJudgeSchema as unknown as Record<string, unknown>,
      ...(images.length > 0 ? { images } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const parsed = result.parsed;

    /**
     * A gate the model failed to answer is treated as *passed*.
     *
     * Deliberate: an unanswered gate is a judge failure, not evidence about the
     * scene, and failing closed would send every scene into the retry budget on
     * a malformed response — turning a judge outage into a job outage.
     */
    const gates: GateResult[] = GATES.map((gate) => {
      const answer = parsed?.gates?.[gate];
      const note = answer?.note?.trim();
      return {
        gate,
        passed: answer?.passed !== false,
        // Only a failing gate's note is kept. A note on a passing gate is either
        // the model explaining itself or, as happened before, the same shared
        // sentence stamped everywhere — neither belongs in a retry prompt.
        ...(note && answer?.passed === false ? { note } : {}),
      };
    });

    return {
      sceneIndex: input.scene.index,
      gates,
      holistic: toScore(parsed?.holistic),
      usage: result.usage,
    };
  }

  private async readImages(paths: readonly string[]): Promise<{ mimeType: string; base64: string }[]> {
    const images: { mimeType: string; base64: string }[] = [];
    for (const path of paths) {
      try {
        images.push({ mimeType: 'image/png', base64: (await readFile(path)).toString('base64') });
      } catch (error) {
        // A missing screenshot degrades the judgement to text-only rather than
        // failing a scene that may be perfectly fine.
        this.logger.warn({ path, err: error }, 'could not read a frame for the judge');
      }
    }
    return images;
  }
}

/** Out-of-range scores are dropped: the score is reported, never gated on. */
function toScore(value: number | undefined): HolisticScore | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const clamped = Math.min(5, Math.max(1, value));
  return HolisticScore.of(clamped);
}
