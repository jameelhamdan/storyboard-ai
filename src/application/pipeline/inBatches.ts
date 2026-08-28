import type { PipelineContext } from './PipelineContext.js';
import type { StageName } from './StageName.js';

/**
 * Walks `items` in batches of `cap`, reporting progress after each.
 *
 * Three stages fan out to a provider under a configured cap, and they used to
 * each write this loop. They disagreed: two reported progress for work
 * *scheduled* rather than work *finished*, so a job sat at 100% of a stage while
 * the last batch was still running. Here, progress means completed — once.
 *
 * The cap doubles as provider rate limiting when many jobs run at once, which is
 * why it is a config value rather than unbounded `Promise.all`.
 */
export async function inBatches<T, R>(
  items: readonly T[],
  cap: number,
  ctx: PipelineContext,
  stage: StageName,
  runBatch: (batch: readonly T[]) => Promise<readonly R[]>,
): Promise<R[]> {
  const results: R[] = [];
  let processed = 0;

  for (let offset = 0; offset < items.length; offset += cap) {
    ctx.throwIfCancelled();
    const batch = items.slice(offset, offset + cap);
    results.push(...(await runBatch(batch)));

    // Counted from the batch, not from `results`: a generator may return fewer
    // results than it was given scenes, and progress must still track the work.
    processed += batch.length;
    ctx.reportProgress(stage, processed / items.length);
  }

  return results;
}
