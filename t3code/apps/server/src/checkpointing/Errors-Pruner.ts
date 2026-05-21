import * as Schema from "effect/Schema";

/**
 * CheckpointPrunerError - Error during checkpoint pruning operation.
 */
export class CheckpointPrunerError extends Schema.TaggedErrorClass<CheckpointPrunerError>()(
  "CheckpointPrunerError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `CheckpointPruner ${this.operation}: ${this.detail}`;
  }
}

/**
 * CheckpointPruneResult - Metrics returned after a pruning run.
 */
export class CheckpointPruneResult extends Schema.Class<CheckpointPruneResult>(
  "CheckpointPruneResult",
)({
  snapshots_deleted: Schema.Number,
  bytes_freed: Schema.Number,
  duration_ms: Schema.Number,
}) {}
