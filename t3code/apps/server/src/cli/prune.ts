/**
 * checkpoint:prune CLI command.
 *
 * Manually triggers checkpoint snapshot pruning with a configurable
 * retention period via --days flag.
 *
 * Reports results: snapshots deleted, bytes freed, duration.
 *
 * @module checkpoint:prune
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import { Flag, Command, GlobalFlag } from "effect/unstable/cli";

import { CheckpointPruner } from "../checkpointing/Services/CheckpointPruner.ts";
import { CheckpointStoreLive } from "../checkpointing/Layers/CheckpointStore.ts";
import { ProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../config.ts";
import { resolveServerConfig, sharedServerCommandFlags, type CliServerFlags } from "./config.ts";

const daysFlag = Flag.integer("days").pipe(
  Flag.withDescription(
    "Retention period in days. Snapshots older than this will be pruned (default: 7).",
  ),
  Flag.optional,
);

const dryRunFlag = Flag.boolean("dry-run").pipe(
  Flag.withDescription(
    "Show which snapshots would be deleted without actually deleting them.",
  ),
  Flag.withDefault(false),
);

const PrunerCliRuntimeLive = Layer.mergeAll(
  CheckpointStoreLive,
  ProjectionSnapshotQueryLive,
  SqlitePersistenceLayerLive,
);

const runPruneCommand = Effect.fn("runPruneCommand")(function* (
  flags: { readonly days?: number; readonly dryRun?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveServerConfig(
    {} as CliServerFlags,
    logLevel,
  );

  const retentionDays = flags.days ?? 7;
  yield* Console.log(`Starting checkpoint pruning (retention: ${retentionDays} days)`);

  if (flags.dryRun) {
    // Dry run: query what would be deleted without actually deleting
    const projectionQuery = yield* ProjectionSnapshotQuery;
    const readModel = yield* projectionQuery.getCommandReadModel();

    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const minKeep = 3;
    const threads = readModel.threads ?? [];

    let eligibleCount = 0;
    let totalApproxBytes = 0;

    for (const thread of threads) {
      const threadContext = yield* projectionQuery
        .getThreadCheckpointContext(thread.threadId)
        .pipe(Effect.catchAll(() => Effect.succeed(Option.none())));

      if (Option.isNone(threadContext)) continue;

      const checkpoints = threadContext.value.checkpoints;
      if (checkpoints.length <= minKeep) continue;

      const sorted = [...checkpoints].sort((a, b) =>
        new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime()
      );

      const eligible = sorted.slice(minKeep);
      for (const cp of eligible) {
        if (new Date(cp.completedAt) < cutoffDate) {
          eligibleCount += 1;
          totalApproxBytes += cp.files?.length * 50_000 ?? 0;
          yield* Console.log(
            `  Would prune: thread=${thread.threadId} turn=${cp.checkpointTurnCount} date=${cp.completedAt}`,
          );
        }
      }
    }

    yield* Console.log(`\n[DRY RUN] Would delete ${eligibleCount} snapshots (~${(totalApproxBytes / 1024).toFixed(1)} KB)`);
    return;
  }

  // Live run: execute pruning
  const pruner = yield* CheckpointPruner;
  const result = yield* pruner.pruneSnapshots({
    retentionDays,
  });

  yield* Console.log(`\nPruning complete:`);
  yield* Console.log(`  Snapshots deleted: ${result.snapshots_deleted}`);
  yield* Console.log(`  Bytes freed: ~${(result.bytes_freed / 1024).toFixed(1)} KB`);
  yield* Console.log(`  Duration: ${result.duration_ms}ms`);
});

export const pruneCommand = Command.make("checkpoint:prune", {
  ...sharedServerCommandFlags,
  days: daysFlag,
  dryRun: dryRunFlag,
}).pipe(
  Command.withDescription(
    "Prune old checkpoint snapshots. Use --days to set retention period (default 7 days). Use --dry-run to preview without deleting.",
  ),
  Command.withHandler((flags) =>
    runPruneCommand({
      days: flags.days,
      dryRun: flags.dryRun,
    }).pipe(Effect.provide(PrunerCliRuntimeLive)),
  ),
);
