import type { VisualPlannerPort, VisualPlanResult } from '@application/port/VisualPlannerPort.js';
import { VisualPlan } from '@domain/media/VisualPlan.js';
import type { Theme } from '@domain/media/Theme.js';

/**
 * Returns the configured theme unchanged.
 *
 * Deliberately not a *different* palette: the stub's job is to let the pipeline
 * run without spend, and inventing colours here would make stub output look
 * unlike anything the real planner produces.
 */
export class StubVisualPlanner implements VisualPlannerPort {
  constructor(private readonly theme: Theme) {}

  public async plan(): Promise<VisualPlanResult> {
    const { tokens } = this.theme;
    return {
      plan: VisualPlan.default({
        ground: tokens.board.background,
        ink: tokens.ink.primary,
        accents: [tokens.ink.accent],
        muted: tokens.ink.muted,
      }),
      usage: { inputTokens: 0, outputTokens: 0, model: 'stub' },
    };
  }
}
