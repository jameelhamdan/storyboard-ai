import type { PipelineContext } from './PipelineContext.js';
import type { StageName } from './StageName.js';

/**
 * One class per pipeline stage, one public method.
 *
 * Stages hold no reference to what runs before or after them and are composed by
 * GenerationPipeline rather than calling each other — which is what makes each one
 * independently testable with a hand-built input.
 *
 * Checkpointing is not a stage's concern: the pipeline persists the whole carry
 * after every stage through one codec, so a stage never writes a serialiser for
 * fields the stage before it already produced.
 */
export interface PipelineStage<TIn, TOut> {
  readonly name: StageName;

  execute(input: TIn, ctx: PipelineContext): Promise<TOut>;
}
