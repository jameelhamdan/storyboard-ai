import type { VideoJob } from '@domain/job/VideoJob.js';
import type { LoggerPort } from '../port/LoggerPort.js';
import type { CostMeterPort } from '../port/CostMeterPort.js';
import type { WorkspacePort } from '../port/WorkspacePort.js';
import type { ResolvedConfig } from './ResolvedConfig.js';
import type { StageName } from './StageName.js';

/**
 * Per-job ambient concerns: cancellation, a logger bound to the job id, the cost
 * meter, the workspace, and resolved config.
 *
 * Created per job and never shared. That is how brief §4's "no shared mutable
 * state between jobs" is satisfied structurally rather than by discipline — two
 * concurrent jobs cannot reach each other's state because neither holds a
 * reference that could.
 */
export interface PipelineContext {
  readonly job: VideoJob;
  readonly config: ResolvedConfig;
  readonly logger: LoggerPort;
  readonly costMeter: CostMeterPort;
  readonly workspace: WorkspacePort;
  readonly signal: AbortSignal;

  /** Progress within the running stage, 0..1 — feeds partial credit. */
  reportProgress(stage: StageName, fraction: number): void;

  /** Throws if the job has been cancelled; called at every stage boundary. */
  throwIfCancelled(): void;
}
