import { readFile } from 'node:fs/promises';
import type { QualityJudgePort, BoardJudgement } from '@application/port/QualityJudgePort.js';
import type { Board } from '@domain/script/Board.js';
import type { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import { GATES, HolisticScore, type GateResult } from '@domain/quality/QualityScore.js';
import type { LlmClientPort } from '@application/port/LlmClientPort.js';
import type { PromptLibrary } from './PromptLibrary.js';
import { sceneJudgeSchema } from './schemas.js';
import type { LoggerPort } from '@application/port/LoggerPort.js';

interface BoardJudgeResponse {
  gates: Record<string, { passed: boolean; note?: string } | undefined>;
  holistic: number;
}

/**
 * Stage B: one vision call per **board** attempt, on the quality tier.
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
 * this is called, and a board failing them never reaches the model at all.
 *
 * The second thing that keeps it affordable is that a board is one call however
 * many scenes it spans. The rubric, the source excerpt and the gate definitions
 * are the bulk of the input and they describe the *diagram*, so sending them
 * once per scene was paying three times to review one picture.
 */
export class PromptedQualityJudge implements QualityJudgePort {
  constructor(
    private readonly client: LlmClientPort,
    private readonly prompts: PromptLibrary,
    private readonly logger: LoggerPort,
  ) {}

  public async judgeBoard(input: {
    board: Board;
    content: ConsolidatedContent;
    screenshotPaths: readonly string[];
    plannedConcept?: string;
    signal?: AbortSignal;
  }): Promise<BoardJudgement> {
    const { board } = input;

    /**
     * The narration labelled by step, when there is more than one.
     *
     * The judge is looking at a sequence of frames and has to be able to say
     * which narration goes with which — that is the whole of gate G2 on a built
     * board. Unlabelled, it sees one wall of text and one pile of images.
     */
    const narration = board.steps === 1
      ? board.firstScene.spokenText
      : board.scenes
          .map((scene, i) => `Step ${i + 1} (image ${i + 1}): ${scene.spokenText}`)
          .join('\n\n');

    const prompt = this.prompts.render('03-scene-judge', {
      narration,
      html: board.html ?? '',
      planned_concept: input.plannedConcept
        ?? '(no design brief was recorded for this board)',
      source: board.scenes
        .flatMap((scene) => scene.citations)
        .map((c) => c.quote ?? c.refs.map((r) => r.key).join(', '))
        .join('\n'),
    });

    const images = await this.readImages(input.screenshotPaths);

    const result = await this.client.generate<BoardJudgeResponse>({
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
      /**
       * A verdict, not an essay.
       *
       * There was no ceiling here at all, so this inherited the client's 8192
       * default and used it: `out/20260828-152720-heart` shows 10,988 output
       * tokens across nine judge calls — about 1,220 per verdict — on the
       * quality tier at $12 per million, which is most of why this stage was
       * 45% of that video's cost. What the caller actually consumes is four
       * booleans, a short note on each *failing* gate, and one number. 400 is
       * generous for that and still an order of magnitude under what was being
       * spent; the retry path handles a truncated response as an unanswered
       * gate, which fails open.
       */
      maxOutputTokens: 400,
      ...(images.length > 0 ? { images } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const parsed = result.parsed;

    /**
     * A gate the model failed to answer is treated as *passed*.
     *
     * Deliberate: an unanswered gate is a judge failure, not evidence about the
     * board, and failing closed would send every board into the retry budget on
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
      sceneIndex: board.firstScene.index,
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
