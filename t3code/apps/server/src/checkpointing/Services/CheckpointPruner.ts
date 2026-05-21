/**
 * CheckpointPruner - Service for pruning old checkpoint snapshots.
 *
 * Removes snapshots older than a configurable retention period while
 * preserving at least the 3 most recent snapshots per session.
 *
 * @module CheckpointPruner
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { CheckpointPrunerError, CheckpointPruneResult } from "../Errors-Pruner.ts";

export interface PruneSnapshotsInput {
  /**
   * Retention period in days. Snapshots older than this are eligible for pruning.
   * @default 7
   */
  readonly retentionDays?: number;

  /**
   * Minimum number of snapshots to keep per session regardless of age.
   * @default 3
   */
  readonly minKeep?: number;
}

export interface CheckpointPrunerShape {
  /**
   * Prune checkpoint snapshots across all sessions.
   *
   * Deletes snapshots older than retentionDays while preserving at least
   * minKeep most recent snapshots per session.
   *
   * Returns pruning metrics: snapshots_deleted, bytes_freed, duration_ms.
   */
  readonly pruneSnapshots: (
    input?: PruneSnapshotsInput,
  ) => Effect.Effect<CheckpointPruneResult, CheckpointPrunerError>;
}

/**
 * CheckpointPruner - Service tag for checkpoint pruning operations.
 */
export class CheckpointPruner extends Context.Service<
  CheckpointPruner,
  CheckpointPrunerShape
>()("t3/checkpointing/Services/CheckpointPruner") {}
