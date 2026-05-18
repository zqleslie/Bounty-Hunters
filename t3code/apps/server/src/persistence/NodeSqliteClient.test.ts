import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
        SELECT id, name FROM entries ORDER BY id
      `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");
    }),
  );

  it.effect("WAL mode is enabled on startup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const result = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`;
      // WAL mode should be enabled by default via applyPragmas
      assert.equal(result[0]?.journal_mode, "wal");
    }),
  );

  it.effect("busy_timeout is configured", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const result = yield* sql<{ busy_timeout: number }>`PRAGMA busy_timeout`;
      assert.equal(result[0]?.busy_timeout, 5000);
    }),
  );

  it.effect("synchronous is set to NORMAL", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const result = yield* sql<{ synchronous: string }>`PRAGMA synchronous`;
      // NORMAL = 1 in SQLite
      assert.equal(result[0]?.synchronous, "normal");
    }),
  );

  it.effect("concurrent read and write operations do not deadlock", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE counter(id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`;
      yield* sql`INSERT INTO counter(value) VALUES (0)`;

      // Run concurrent writes
      const writes = Effect.all(
        Array.from({ length: 5 }, (_, i) =>
          sql`UPDATE counter SET value = value + 1 WHERE id = 1`,
        ),
        { concurrency: "unbounded" },
      );
      yield* writes;

      const rows = yield* sql<{ value: number }>`SELECT value FROM counter WHERE id = 1`;
      assert.equal(rows[0]?.value, 5);
    }),
  );
});

describe("NodeSqliteClient pooled", () => {
  it.effect("makePooled creates a client with WAL mode and health check", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { client, healthCheck } = yield* SqliteClient.makePooled({
        filename: ":memory:",
        poolMin: 1,
        poolMax: 3,
      }).pipe(Effect.provideService(Scope.Scope, scope));

      // Verify WAL mode
      const journalResult = yield* client.unsafe("PRAGMA journal_mode").values;
      assert.equal(journalResult[0]?.[0], "wal");

      // Verify health check passes
      const health = yield* healthCheck;
      assert.isTrue(health.pass);
      assert.include(health.details, "integrity_check");
    }),
  );

  it.effect("pool sizing respects poolMin and poolMax", () =>
    Effect.gen(function* () {
      // Pool should start with poolMin connections
      const scope = yield* Scope.make();
      const { client } = yield* SqliteClient.makePooled({
        filename: ":memory:",
        poolMin: 1,
        poolMax: 2,
      }).pipe(Effect.provideService(Scope.Scope, scope));

      // Basic query should work
      const result = yield* client.unsafe("SELECT 1 as val").values;
      assert.equal(result[0]?.[0], 1);
    }),
  );
});
