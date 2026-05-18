/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";

import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { constant, identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export const TypeId: TypeId = "~local/sqlite-node/SqliteClient";

export type TypeId = "~local/sqlite-node/SqliteClient";

/**
 * SqliteClient - Effect service tag for the sqlite SQL client.
 */
export const SqliteClient = Context.Service<Client.SqlClient>("t3/persistence/NodeSqliteClient");

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
  /** Enable WAL journal mode for better concurrent access performance */
  readonly walMode?: boolean | undefined;
  /** Busy timeout in milliseconds before failing on lock contention (default: 5000) */
  readonly busyTimeout?: number | undefined;
  /** Synchronous mode for WAL (default: "NORMAL") */
  readonly synchronous?: "NORMAL" | "FULL" | "OFF" | undefined;
}

export interface SqlitePoolConfig extends SqliteClientConfig {
  /** Minimum number of connections in the pool (default: 1) */
  readonly poolMin?: number | undefined;
  /** Maximum number of connections in the pool (default: 5) */
  readonly poolMax?: number | undefined;
}

export interface SqliteMemoryClientConfig extends Omit<
  SqliteClientConfig,
  "filename" | "readonly"
> {}

// -----------------------------------------------------------------------------
// Connection Pool
// -----------------------------------------------------------------------------

interface PooledConnection {
  readonly connection: Connection;
  readonly db: DatabaseSync;
}

const applyPragmas = (db: DatabaseSync, config: SqliteClientConfig): void => {
  if (config.walMode !== false) {
    db.pragma("journal_mode=WAL");
  }
  db.pragma(`busy_timeout=${config.busyTimeout ?? 5000}`);
  db.pragma(`synchronous=${config.synchronous ?? "NORMAL"}`);
};

const runHealthCheck = Effect.fn("sqliteHealthCheck")(function* (
  db: DatabaseSync,
): Effect.fn.Return<{ pass: boolean; details: string }, never> {
  try {
    const result = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const status = result?.[0]?.integrity_check;
    if (status === "ok") {
      return { pass: true, details: "integrity_check passed" };
    }
    return { pass: false, details: `integrity_check failed: ${status}` };
  } catch (cause) {
    return { pass: false, details: `integrity_check error: ${cause}` };
  }
});

/**
 * Create a connection pool using Effect.Queue as a simple pool implementation.
 * Connections are acquired from the pool, used, and returned with PRAGMA reset
 * to ensure a clean state.
 */
const makePool = Effect.fn("makeSqlitePool")(function* (
  config: SqlitePoolConfig,
  openDatabase: () => DatabaseSync,
): Effect.fn.Return<
  {
    readonly acquire: Effect.Effect<PooledConnection, never, Scope.Scope>;
    readonly size: Effect.Effect<number>;
    readonly healthCheck: Effect.Effect<{ pass: boolean; details: string }, never>;
  },
  never,
  Scope.Scope | Reactivity.Reactivity
> {
  yield* checkNodeSqliteCompat();

  const poolMin = config.poolMin ?? 1;
  const poolMax = config.poolMax ?? 5;
  const scope = yield* Effect.scope;

  // Create the bounded queue (acts as pool semaphore)
  const queue = yield* Queue.bounded<PooledConnection>(poolMax);

  // Pre-warm with minimum connections
  const connections: PooledConnection[] = [];
  for (let i = 0; i < poolMin; i++) {
    const db = openDatabase();
    applyPragmas(db, config);
    const conn = yield* makeSingleConnection(db, config, scope);
    const pooled: PooledConnection = { connection: conn, db };
    connections.push(pooled);
    yield* Queue.offer(queue, pooled);
  }

  // Lazy expansion: track current pool size
  let currentSize = poolMin;

  const acquire = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      // Try to get from queue with timeout
      const maybeConn = yield* Queue.poll(queue).pipe(
        Effect.flatMap((opt) =>
          Option.isSome(opt)
            ? Effect.succeed(opt.value)
            : Effect.succeed(null as PooledConnection | null),
        ),
      );

      if (maybeConn !== null) {
        return maybeConn;
      }

      // Queue empty 鈥?expand pool if under max
      if (currentSize < poolMax) {
        currentSize++;
        const db = openDatabase();
        applyPragmas(db, config);
        const conn = yield* makeSingleConnection(db, config, scope);
        return { connection: conn, db } as PooledConnection;
      }

      // Pool at max 鈥?wait for a connection with timeout
      return yield* restore(
        Queue.take(queue).pipe(Effect.timeoutFail({
          duration: Duration.seconds(10),
          onTimeout: () =>
            new SqlError({
              reason: classifySqliteError(new Error("Pool acquisition timeout (10s)"), {
                message: "Connection pool acquisition timed out after 10 seconds",
                operation: "acquire",
              }),
            }),
        })),
      );
    }),
  );

  const release = (pooled: PooledConnection): Effect.Effect<void> =>
    Effect.sync(() => {
      // Reset connection to clean state before returning to pool
      try {
        pooled.db.pragma("reset");
      } catch {
        // ignore reset errors
      }
    }).pipe(Effect.andThen(Queue.offer(queue, pooled)));

  const size = Effect.sync(() => currentSize);

  // Health check uses the first available connection (or creates a temp one)
  const healthCheck = Effect.gen(function* () {
    const pooled = yield* acquire;
    try {
      return yield* runHealthCheck(pooled.db);
    } finally {
      yield* release(pooled);
    }
  });

  // Return a wrapped acquirer that auto-releases via Scope finalizer
  const scopedAcquire = Effect.acquireRelease(
    acquire,
    release,
  );

  return { acquire: scopedAcquire, size, healthCheck };
});

const makeSingleConnection = (
  db: DatabaseSync,
  options: SqliteClientConfig,
  scope: Scope.Scope,
): Effect.Effect<Connection> =>
  Effect.gen(function* () {
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => db.close()),
    );

    const statementReaderCache = new WeakMap<StatementSync, boolean>();
    const hasRows = (statement: StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) return cached;
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepareCache = yield* Cache.make({
      capacity: options.prepareCacheSize ?? 200,
      timeToLive: options.prepareCacheTTL ?? Duration.minutes(10),
      lookup: (sql: string) =>
        Effect.try({
          try: () => db.prepare(sql),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, {
                message: "Failed to prepare statement",
                operation: "prepare",
              }),
            }),
        }),
    });

    const runStatement = (statement: StatementSync, params: ReadonlyArray<unknown>, raw: boolean) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
        try {
          if (hasRows(statement)) {
            return Effect.succeed(statement.all(...(params as any)));
          }
          const result = statement.run(...(params as any));
          return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : []);
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, {
                message: "Failed to execute statement",
                operation: "execute",
              }),
            }),
          );
        }
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (s) => runStatement(s, params, raw));

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.acquireUseRelease(
        Cache.get(prepareCache, sql),
        (statement) =>
          Effect.try({
            try: () => {
              if (hasRows(statement)) {
                statement.setReturnArrays(true);
                return statement.all(...(params as any)) as unknown as ReadonlyArray<ReadonlyArray<unknown>>;
              }
              statement.run(...(params as any));
              return [];
            },
            catch: (cause) =>
              new SqlError({
                reason: classifySqliteError(cause, {
                  message: "Failed to execute statement",
                  operation: "execute",
                }),
              }),
          }),
        (statement) =>
          Effect.sync(() => {
            if (hasRows(statement)) {
              statement.setReturnArrays(false);
            }
          }),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = runStatement(db.prepare(sql), params ?? [], false);
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die("executeStream not implemented");
      },
    });
  });

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` 鈥?specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      `Node.js ${process.versions.node} is missing required node:sqlite APIs ` +
        `(StatementSync.columns). Upgrade to Node.js >=22.16, >=23.11, or >=24.`,
    );
  }
  return Effect.void;
};

// -----------------------------------------------------------------------------
// Backward-compatible single-connection client (uses pool with min=max=1)
// -----------------------------------------------------------------------------

const makeWithDatabase = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
  openDatabase: () => DatabaseSync,
): Effect.fn.Return<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> {
  // Apply WAL and other pragmas on the single connection for backward compat
  const db = openDatabase();
  applyPragmas(db, options);

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const connection = yield* makeSingleConnection(db, options, yield* Effect.scope);

  const acquirer = Effect.succeed(connection);
  const transactionAcquirer = Effect.succeed(connection);

  return yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer,
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
      ["db.journal_mode", "wal"],
    ],
    transformRows,
  });
});

// -----------------------------------------------------------------------------
// Pool-based client
// -----------------------------------------------------------------------------

const makeWithPool = Effect.fn("makeWithPool")(function* (
  config: SqlitePoolConfig,
  openDatabase: () => DatabaseSync,
): Effect.fn.Return<
  { client: Client.SqlClient; healthCheck: Effect.Effect<{ pass: boolean; details: string }, never> },
  never,
  Scope.Scope | Reactivity.Reactivity
> {
  const pool = yield* makePool(config, openDatabase);

  const compiler = Statement.makeCompilerSqlite(config.transformQueryNames);
  const transformRows = config.transformResultNames
    ? Statement.defaultTransforms(config.transformResultNames).array
    : undefined;

  const acquirer = Effect.map(pool.acquire, (p) => p.connection);
  const transactionAcquirer = Effect.map(pool.acquire, (p) => p.connection);

  const client = yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer,
    spanAttributes: [
      ...(config.spanAttributes ? Object.entries(config.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
      ["db.journal_mode", "wal"],
      ["db.pool.min", config.poolMin ?? 1],
      ["db.pool.max", config.poolMax ?? 5],
    ],
    transformRows,
  });

  return { client, healthCheck: pool.healthCheck };
});

const make = (
  options: SqliteClientConfig,
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    options,
    () => {
      const db = new DatabaseSync(options.filename, {
        readOnly: options.readonly ?? false,
        allowExtension: options.allowExtension ?? false,
      });
      // WAL mode and pragmas are now applied in makeWithDatabase via applyPragmas
      return db;
    },
  );

/**
 * Create a pooled SQLite client with WAL mode, connection pooling (1-5 connections),
 * busy timeout, and health check support.
 */
export const makePooled = (
  config: SqlitePoolConfig,
): Effect.Effect<
  { client: Client.SqlClient; healthCheck: Effect.Effect<{ pass: boolean; details: string }, never> },
  never,
  Scope.Scope | Reactivity.Reactivity
> =>
  makeWithPool(
    config,
    () =>
      new DatabaseSync(config.filename, {
        readOnly: config.readonly ?? false,
        allowExtension: config.allowExtension ?? false,
      }),
  );

const makeMemory = (
  config: SqliteMemoryClientConfig = {},
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    {
      ...config,
      filename: ":memory:",
      readonly: false,
    },
    () => {
      const database = new DatabaseSync(":memory:", {
        allowExtension: config.allowExtension ?? false,
      });
      return database;
    },
  );

export const layerConfig = (
  config: Config.Wrap<SqliteClientConfig>,
): Layer.Layer<Client.SqlClient, Config.ConfigError> =>
  Layer.effectContext(
    Config.unwrap(config)
      .asEffect()
      .pipe(
        Effect.flatMap(make),
        Effect.map((client) =>
          Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
        ),
      ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(make(config), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layerMemory = (config: SqliteMemoryClientConfig = {}): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(makeMemory(config), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

// -----------------------------------------------------------------------------
// Pool layer
// -----------------------------------------------------------------------------

export const poolLayerConfig = (
  config: Config.Wrap<SqlitePoolConfig>,
): Layer.Layer<never, Config.ConfigError> =>
  Layer.effectContext(
    Config.unwrap(config)
      .asEffect()
      .pipe(
        Effect.flatMap((cfg) => makeWithPool(cfg, () => new DatabaseSync(cfg.filename, {
          readOnly: cfg.readonly ?? false,
          allowExtension: cfg.allowExtension ?? false,
        }))),
        Effect.map(({ client, healthCheck }) => {
          // Log health check result on startup
          return Effect.map(healthCheck, (result) => {
            if (result.pass) {
              console.log(`[SQLite] Health check passed: ${result.details}`);
            } else {
              console.warn(`[SQLite] Health check failed: ${result.details}`);
            }
            return Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client));
          });
        }),
        Effect.flatMap(identity),
      ),
  ).pipe(Layer.provide(Reactivity.layer));

export const poolLayer = (config: SqlitePoolConfig): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(makePooled(config), ({ client }) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));
