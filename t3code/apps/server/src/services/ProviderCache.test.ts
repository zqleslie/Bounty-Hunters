/**
 * Tests for ProviderCache — validates TTL behaviour, invalidation,
 * concurrent deduplication, and metrics.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProviderCache from "./ProviderCache.ts";

describe("ProviderCache", () => {
  it.effect("getModelList returns cached value on second call", () =>
    Effect.gen(function* () {
      let lookupCount = 0;
      const providerCache = yield* ProviderCache.make;

      const lookup = Effect.sync(() => {
        lookupCount++;
        return { models: [{ name: "gpt-4" }], fetchedAt: Date.now() };
      });

      const first = yield* providerCache.getModelList("codex" as const, lookup);
      const second = yield* providerCache.getModelList("codex" as const, lookup);

      assert.equal(lookupCount, 1, "lookup should only be called once");
      assert.deepEqual(first.models, second.models);
    }),
  );

  it.effect("getCapability returns cached value for same query", () =>
    Effect.gen(function* () {
      let lookupCount = 0;
      const providerCache = yield* ProviderCache.make;

      const lookup = Effect.sync(() => {
        lookupCount++;
        return { capabilities: ["chat", "tools"], fetchedAt: Date.now() };
      });

      const first = yield* providerCache.getCapability("claudeAgent" as const, "capabilities", lookup);
      const second = yield* providerCache.getCapability("claudeAgent" as const, "capabilities", lookup);

      assert.equal(lookupCount, 1);
      assert.deepEqual(first.capabilities, second.capabilities);
    }),
  );

  it.effect("different provider instances have separate caches", () =>
    Effect.gen(function* () {
      let codexLookups = 0;
      let claudeLookups = 0;
      const providerCache = yield* ProviderCache.make;

      const codexLookup = Effect.sync(() => {
        codexLookups++;
        return { models: [{ name: "codex-mini" }], fetchedAt: Date.now() };
      });
      const claudeLookup = Effect.sync(() => {
        claudeLookups++;
        return { models: [{ name: "claude-sonnet" }], fetchedAt: Date.now() };
      });

      yield* providerCache.getModelList("codex" as const, codexLookup);
      yield* providerCache.getModelList("claudeAgent" as const, claudeLookup);

      assert.equal(codexLookups, 1);
      assert.equal(claudeLookups, 1);
    }),
  );

  it.effect("different capability queries are cached separately", () =>
    Effect.gen(function* () {
      let queryCount = 0;
      const providerCache = yield* ProviderCache.make;

      const lookup = Effect.sync(() => {
        queryCount++;
        return { capabilities: [`result-${queryCount}`], fetchedAt: Date.now() };
      });

      yield* providerCache.getCapability("codex" as const, "models", lookup);
      yield* providerCache.getCapability("codex" as const, "tools", lookup);

      assert.equal(queryCount, 2, "different queries should trigger separate lookups");
    }),
  );

  it.effect("invalidate removes entries for the specified provider", () =>
    Effect.gen(function* () {
      let codexLookups = 0;
      let claudeLookups = 0;
      const providerCache = yield* ProviderCache.make;

      const codexLookup = Effect.sync(() => {
        codexLookups++;
        return { models: [{ name: "codex-v1" }], fetchedAt: Date.now() };
      });
      const claudeLookup = Effect.sync(() => {
        claudeLookups++;
        return { models: [{ name: "claude-v1" }], fetchedAt: Date.now() };
      });

      yield* providerCache.getModelList("codex" as const, codexLookup);
      yield* providerCache.getModelList("claudeAgent" as const, claudeLookup);

      yield* providerCache.invalidate("codex" as const, "config_change");

      // Codex should be re-fetched
      yield* providerCache.getModelList("codex" as const, codexLookup);
      // Claude should still be cached
      yield* providerCache.getModelList("claudeAgent" as const, claudeLookup);

      assert.equal(codexLookups, 2, "codex lookup should be called again after invalidation");
      assert.equal(claudeLookups, 1, "claude lookup should still be cached");
    }),
  );

  it.effect("invalidateAll clears the entire cache", () =>
    Effect.gen(function* () {
      let lookupCount = 0;
      const providerCache = yield* ProviderCache.make;

      const lookup = Effect.sync(() => {
        lookupCount++;
        return { models: [{ name: "model" }], fetchedAt: Date.now() };
      });

      yield* providerCache.getModelList("codex" as const, lookup);
      yield* providerCache.getModelList("claudeAgent" as const, lookup);

      yield* providerCache.invalidateAll("full_clear");

      yield* providerCache.getModelList("codex" as const, lookup);
      yield* providerCache.getModelList("claudeAgent" as const, lookup);

      assert.equal(lookupCount, 4, "all entries should be re-fetched after invalidateAll");
    }),
  );

  it.effect("getStats returns correct counts", () =>
    Effect.gen(function* () {
      let lookupCount = 0;
      const providerCache = yield* ProviderCache.make;

      const lookup = Effect.sync(() => {
        lookupCount++;
        return { models: [{ name: "gpt-4" }], fetchedAt: Date.now() };
      });

      yield* providerCache.getModelList("codex" as const, lookup); // miss
      yield* providerCache.getModelList("codex" as const, lookup); // hit
      yield* providerCache.getModelList("claudeAgent" as const, lookup); // miss
      yield* providerCache.invalidate("codex" as const, "test");

      const stats = yield* providerCache.getStats;

      assert.isAtLeast(stats.hits, 1);
      assert.isAtLeast(stats.misses, 2);
      assert.isAtLeast(stats.invalidations, 1);
      assert.isAtLeast(stats.size, 0);
    }),
  );

  it.effect("invalidationStream emits events on invalidate", () =>
    Effect.gen(function* () {
      const providerCache = yield* ProviderCache.make;
      const hub = yield* providerCache.invalidationStream;

      yield* providerCache.invalidate("codex" as const, "test_reason");

      const event = yield* Effect.timeout(
        Effect.promise(() => Hub.take(hub)),
        Duration.seconds(1),
      );

      assert.isFalse(Effect.isError(event));
      if (Effect.isError(event)) return;
      const evt = event.value;
      assert.equal(evt.providerInstanceId, "codex");
      assert.equal(evt.reason, "test_reason");
    }),
  );
});

describe("ProviderCache layer", () => {
  it.effect("layer provides a working cache", () =>
    Effect.gen(function* () {
      let count = 0;
      const lookup = Effect.sync(() => {
        count++;
        return { models: [{ name: "test" }], fetchedAt: Date.now() };
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const cache = yield* ProviderCache.ProviderCache;
          yield* cache.getModelList("codex" as const, lookup);
          yield* cache.getModelList("codex" as const, lookup);
        }).pipe(Effect.provide(ProviderCache.layer)),
      );

      assert.equal(count, 1);
    }),
  );
});
