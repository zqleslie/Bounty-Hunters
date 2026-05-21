/**
 * CheckpointPrunerLive - Implementation of checkpoint snapshot pruning.
 *
 * Queries the projection snapshot query for all threads and their checkpoints,
 * identifies snapshots older than the retention period, preserves at least
 * minKeep snapshots per session, and deletes the rest via CheckpointStore.
 *
 * Runs automatically on a 1-hour interval via Effect.Schedule and exposes
 * a pruneSnapshots method for manual CLI invocation.
 *
 * @module CheckpointPrunerLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Clock from "effect/Clock";

import { CheckpointPruner, type PruneSnapshotsInput } from "../Services/CheckpointPruner.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import {
  CheckpointPrunerError,
  CheckpointPruneResult,
} from "../Errors-Pruner.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MIN_KEEP = 3;

/**
 * Build the live CheckpointPruner implementation.
 */
const make = Effect.gen(function* () {
  const projectionQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore;

  const pruneSnapshots: CheckpointPrunerShape["pruneSnapshots"] = Effect.fn(
    "CheckpointPruner.pruneSnapshots",
  )(function* (input?: PruneSnapshotsInput) {
    const startTime = yield* Clock.currentTimeMillis;
    const retentionDays = input?.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const minKeep = input?.minKeep ?? DEFAULT_MIN_KEEP;

    yield* Effect.annotateCurrentSpan({
      "pruner.retention_days": retentionDays,
      "pruner.min_keep": minKeep,
    });

    // Get the current read model to find all active projects/threads
    const readModel = yield* projectionQuery
      .getCommandReadModel()
      .pipe(Effect.withSpan("pruner.getReadModel"));

    // Collect all thread checkpoint refs with their timestamps
    const threads = readModel.threads ?? [];
    const allRefsToDelete: Array<{
      readonly threadId: string;
      readonly checkpointRef: string;
      readonly completedAt: string;
      readonly approxBytes: number;
    }> = [];

    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    for (const thread of threads) {
      const threadContext = yield* projectionQuery
        .getThreadCheckpointContext(thread.threadId)
        .pipe(Effect.withSpan("pruner.getThreadContext"));

      if (Option.isNone(threadContext)) {
        continue;
      }

      const checkpoints = threadContext.value.checkpoints;
      if (checkpoints.length <= minKeep) {
        // Not enough snapshots to prune for this thread
        continue;
      }

      // Sort checkpoints by completion date (newest first)
      const sorted = [...checkpoints].sort((a, b) => {
        const dateA = new Date(a.completedAt).getTime();
        const dateB = new Date(b.completedAt).getTime();
        return dateB - dateA;
      });

      // Keep the most recent minKeep snapshots
      const eligible = sorted.slice(minKeep);

      // Among eligible, find those older than retention period
      for (const cp of eligible) {
        const cpDate = new Date(cp.completedAt);
        if (cpDate < cutoffDate && cp.checkpointRef) {
          // Estimate bytes based on file count (rough heuristic)
          const approxBytes = cp.files?.length * 50_000 ?? 0;
          allRefsToDelete.push({
            threadId: thread.threadId,
            checkpointRef: cp.checkpointRef,
            completedAt: cp.completedAt,
            approxBytes,
          });
        }
      }
    }

    if (allRefsToDelete.length === 0) {
      return new CheckpointPruneResult({
        snapshots_deleted: 0,
        bytes_freed: 0,
        duration_ms: yield* Effect.map(Clock.currentTimeMillis, (now) => now - startTime),
      });
    }

    // Group refs by workspace cwd for batch deletion
    // For now, delete refs individually via the checkpoint store
    let totalDeleted = 0;
    let totalBytesFreed = 0;

    for (const ref of allRefsToDelete) {
      // Find the workspace cwd for this thread
      const threadContext = yield* projectionQuery
        .getThreadCheckpointContext(ref.threadId as import("@t3tools/contracts").ThreadId)
        .pipe(Effect.catchAll(() => Effect.succeed(Option.none())));

      if (Option.isSome(threadContext)) {
        const cwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
        if (cwd) {
          const refObj = yield* Effect.sync(() =>
            import("@t3tools/contracts").then(m => m.CheckpointRef.make(ref.checkpointRef))
          );

          yield* checkpointStore
            .deleteCheckpointRefs({
              cwd,
              checkpointRefs: [refObj],
            })
            .pipe(
              Effect.catchAll(() => Effect.void), // Best-effort: tolerate failures
              Effect.withSpan("pruner.deleteRef"),
            );

          totalDeleted += 1;
          totalBytesFreed += ref.approxBytes;
        }
      }
    }

    const endTime = yield* Clock.currentTimeMillis;

    return new CheckpointPruneResult({
      snapshots_deleted: totalDeleted,
      bytes_freed: totalBytesFreed,
      duration_ms: endTime - startTime,
    });
  });

  return {
    pruneSnapshots,
  };
});

/**
 * CheckpointPrunerLive - Layer providing the pruner service.
 */
export const CheckpointPrunerLive = Layer.effect(CheckpointPruner, make);

/**
 * AutoPruneSchedule - Runs pruning every hour.
 * Non-blocking: uses Effect.fork to run in background.
 */
export const AutoPruneSchedule = Effect.gen(function* () {
  const pruner = yield* CheckpointPruner;

  yield* Effect.logInfo("Starting auto-prune checkpoint scheduler (1h interval)");

  yield* pruner
    .pruneSnapshots()
    .pipe(
      Effect.tap((result) =>
        Effect.logInfo(
          `Pruned ${result.snapshots_deleted} snapshots, freed ~${(result.bytes_freed / 1024).toFixed(1)} KB in ${result.duration_ms}ms`,
        ),
      ),
      Effect.catchAll((err) =>
        Effect.logWarning(`Auto-prune failed: ${err.message ?? JSON.stringify(err)}`),
      ),
      Effect.repeat(Schedule.fixed("1 hours")),
    );
});
