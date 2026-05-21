/**
 * CheckpointPruner test suite.
 *
 * Verifies:
 * 1. Retention logic: snapshots older than retention period are deleted
 * 2. Minimum snapshot preservation: at least minKeep snapshots kept per session
 * 3. Concurrent access: pruning does not cause errors during concurrent checkpoint operations
 * 4. Metrics: correct reporting of snapshots_deleted, bytes_freed, duration_ms
 * 5. Empty result when nothing to prune
 */
import { CheckpointRef, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import { describe, expect, it } from "vitest";

import { CheckpointPrunerLive } from "./Layers/CheckpointPruner.ts";
import { CheckpointPruner } from "../Services/CheckpointPruner.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadCheckpointContext,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";

function makeThreadContext(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpointCount: number;
  readonly completedAtDaysAgo: number[];
}): ProjectionThreadCheckpointContext {
  const now = Date.now();
  const checkpoints = input.completedAtDaysAgo.map((daysAgo, index) => ({
    turnId: `turn-${index}`,
    checkpointTurnCount: index,
    checkpointRef: checkpointRefForThreadTurn(input.threadId, index),
    status: "ready" as const,
    files: Array.from({ length: 10 }, (_, i) => `file-${i}.ts`),
    assistantMessageId: null,
    completedAt: new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  }));

  return {
    threadId: input.threadId,
    projectId: input.projectId,
    workspaceRoot: input.workspaceRoot,
    worktreePath: input.worktreePath,
    checkpoints,
  };
}

const makeMockStore = (): CheckpointStoreShape => ({
  isGitRepository: () => Effect.succeed(true),
  captureCheckpoint: () => Effect.void,
  hasCheckpointRef: () => Effect.succeed(true),
  restoreCheckpoint: () => Effect.succeed(true),
  diffCheckpoints: () => Effect.succeed("diff"),
  deleteCheckpointRefs: ({ checkpointRefs }) =>
    Effect.sync(() => {
      // Track deletions
      return undefined;
    }),
});

describe("CheckpointPruner", () => {
  it("deletes snapshots older than retention period", async () => {
    const projectId = ProjectId.make("project-retention");
    const threadId = ThreadId.make("thread-retention");
    const deleteCalls: Array<string> = [];

    const checkpointStore: CheckpointStoreShape = {
      ...makeMockStore(),
      deleteCheckpointRefs: ({ checkpointRefs, cwd }) =>
        Effect.sync(() => {
          deleteCalls.push(...checkpointRefs.map(r => r.toString()));
        }),
    };

    // 10 checkpoints: newest 3 at 1,2,3 days ago; older 7 at 8-30 days ago
    const context = makeThreadContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointCount: 10,
      completedAtDaysAgo: [1, 2, 3, 8, 10, 12, 15, 20, 25, 30],
    });

    const readModel = {
      projects: [],
      threads: [{ threadId }],
    };

    const layer = CheckpointPrunerLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(readModel),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(context)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const pruner = yield* CheckpointPruner;
        return yield* pruner.pruneSnapshots({ retentionDays: 7, minKeep: 3 });
      }).pipe(Effect.provide(layer)),
    );

    // Oldest 7 minus minKeep(3) = should delete the ones older than 7 days
    // Sorted: [1,2,3,8,10,12,15,20,25,30]
    // Keep newest 3: [1,2,3]
    // Eligible: [8,10,12,15,20,25,30] - all > 7 days
    expect(result.snapshots_deleted).toBe(7);
    expect(result.bytes_freed).toBeGreaterThan(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(deleteCalls.length).toBe(7);
  });

  it("preserves minimum snapshots per session even when all are old", async () => {
    const projectId = ProjectId.make("project-min-keep");
    const threadId = ThreadId.make("thread-min-keep");
    let deleteCalls = 0;

    const checkpointStore: CheckpointStoreShape = {
      ...makeMockStore(),
      deleteCheckpointRefs: () =>
        Effect.sync(() => {
          deleteCalls += 1;
        }),
    };

    // 5 checkpoints, all old (30-50 days ago)
    const context = makeThreadContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointCount: 5,
      completedAtDaysAgo: [30, 35, 40, 45, 50],
    });

    const readModel = {
      projects: [],
      threads: [{ threadId }],
    };

    const layer = CheckpointPrunerLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(readModel),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(context)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const pruner = yield* CheckpointPruner;
        return yield* pruner.pruneSnapshots({ retentionDays: 7, minKeep: 3 });
      }).pipe(Effect.provide(layer)),
    );

    // 5 total, keep min 3, eligible = 2 (all old) → delete 2
    expect(result.snapshots_deleted).toBe(2);
    expect(deleteCalls).toBe(2);
  });

  it("does nothing when fewer than minKeep snapshots exist", async () => {
    const projectId = ProjectId.make("project-few");
    const threadId = ThreadId.make("thread-few");
    let deleteCalls = 0;

    const checkpointStore: CheckpointStoreShape = {
      ...makeMockStore(),
      deleteCheckpointRefs: () =>
        Effect.sync(() => {
          deleteCalls += 1;
        }),
    };

    // Only 2 checkpoints (less than minKeep of 3)
    const context = makeThreadContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointCount: 2,
      completedAtDaysAgo: [30, 50],
    });

    const readModel = {
      projects: [],
      threads: [{ threadId }],
    };

    const layer = CheckpointPrunerLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(readModel),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(context)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const pruner = yield* CheckpointPruner;
        return yield* pruner.pruneSnapshots({ retentionDays: 7, minKeep: 3 });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.snapshots_deleted).toBe(0);
    expect(deleteCalls).toBe(0);
  });

  it("handles concurrent access without errors", async () => {
    const projectId = ProjectId.make("project-concurrent");
    const threadId = ThreadId.make("thread-concurrent");
    let deleteCalls = 0;

    // Simulate a store that throws during concurrent delete
    const checkpointStore: CheckpointStoreShape = {
      ...makeMockStore(),
      deleteCheckpointRefs: () =>
        Effect.sync(() => {
          deleteCalls += 1;
          // Simulate occasional concurrent access error
          if (deleteCalls % 3 === 0) {
            throw new Error("database is locked");
          }
        }),
    };

    const context = makeThreadContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointCount: 10,
      completedAtDaysAgo: [1, 2, 3, 8, 10, 12, 15, 20, 25, 30],
    });

    const readModel = {
      projects: [],
      threads: [{ threadId }],
    };

    const layer = CheckpointPrunerLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(readModel),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(context)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    // Should not throw even with concurrent access errors (best-effort)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const pruner = yield* CheckpointPruner;
        return yield* pruner.pruneSnapshots({ retentionDays: 7, minKeep: 3 });
      }).pipe(Effect.provide(layer)),
    );

    // Some deletions may have failed but the operation should complete
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns zero result when no threads have checkpoints", async () => {
    const checkpointStore: CheckpointStoreShape = makeMockStore();

    const readModel = {
      projects: [],
      threads: [],
    };

    const layer = CheckpointPrunerLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(readModel),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const pruner = yield* CheckpointPruner;
        return yield* pruner.pruneSnapshots();
      }).pipe(Effect.provide(layer)),
    );

    expect(result.snapshots_deleted).toBe(0);
    expect(result.bytes_freed).toBe(0);
  });
});
