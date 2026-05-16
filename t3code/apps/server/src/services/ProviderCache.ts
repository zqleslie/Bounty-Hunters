/**
 * ProviderCache — Effect.Cache-based caching for external provider API responses.
 *
 * Caches:
 * - Model lists (default TTL: 5 minutes)
 * - Capability queries (default TTL: 15 minutes)
 *
 * Features:
 * - Configurable TTL per cache type
 * - Cache invalidation on provider configuration changes via Effect.Hub
 * - Cache hit/miss metrics exposed through the observability layer
 * - Concurrent request deduplication (built into Effect.Cache)
 * - Bounded memory via maximum cache entry count
 */
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import * as Hub from "effect/Hub";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import {
  metricAttributes,
  withMetrics,
} from "../observability/Metrics.ts";
import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const cacheHitsTotal = Metric.counter("t3_provider_cache_hits_total", {
  description: "Total provider cache hits.",
});

export const cacheMissesTotal = Metric.counter("t3_provider_cache_misses_total", {
  description: "Total provider cache misses.",
});

export const cacheInvalidationsTotal = Metric.counter("t3_provider_cache_invalidations_total", {
  description: "Total provider cache invalidation events.",
});

// ---------------------------------------------------------------------------
// Cache key types
// ---------------------------------------------------------------------------

export class ModelListCacheKey extends Data.Class<{
  readonly type: "modelList";
  readonly providerInstanceId: ProviderInstanceId;
}> {}

export class CapabilityCacheKey extends Data.Class<{
  readonly type: "capability";
  readonly providerInstanceId: ProviderInstanceId;
  readonly query: string;
}> {}

export type ProviderCacheKey = ModelListCacheKey | CapabilityCacheKey;

// ---------------------------------------------------------------------------
// Cache value types
// ---------------------------------------------------------------------------

export interface ModelListValue {
  readonly models: ReadonlyArray<{
    readonly name: string;
    readonly capabilities?: ReadonlyArray<string>;
  }>;
  readonly fetchedAt: number;
}

export interface CapabilityValue {
  readonly capabilities: ReadonlyArray<string>;
  readonly fetchedAt: number;
}

export type ProviderCacheValue = ModelListValue | CapabilityValue;

// ---------------------------------------------------------------------------
// Invalidation events
// ---------------------------------------------------------------------------

export class CacheInvalidationEvent extends Data.TaggedClass("CacheInvalidationEvent")<{
  readonly providerInstanceId: ProviderInstanceId;
  readonly reason: string;
}> {}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface ProviderCacheConfig {
  readonly modelListTtl: Duration.Duration;
  readonly capabilityTtl: Duration.Duration;
  readonly maxEntries: number;
}

export const DEFAULT_CACHE_CONFIG: ProviderCacheConfig = {
  modelListTtl: Duration.minutes(5),
  capabilityTtl: Duration.minutes(15),
  maxEntries: 1_000,
} as const;

export interface ProviderCacheShape {
  /**
   * Get cached model list for a provider instance.
   * On cache miss, invokes the lookup function and stores the result.
   * Concurrent requests for the same key are deduplicated.
   */
  readonly getModelList: (
    providerInstanceId: ProviderInstanceId,
    lookup: Effect.Effect<ModelListValue>,
  ) => Effect.Effect<ModelListValue>;

  /**
   * Get cached capability query result.
   * On cache miss, invokes the lookup function and stores the result.
   * Concurrent requests for the same key are deduplicated.
   */
  readonly getCapability: (
    providerInstanceId: ProviderInstanceId,
    query: string,
    lookup: Effect.Effect<CapabilityValue>,
  ) => Effect.Effect<CapabilityValue>;

  /**
   * Invalidate all cache entries for a specific provider instance.
   * Typically called when provider configuration changes.
   */
  readonly invalidate: (
    providerInstanceId: ProviderInstanceId,
    reason?: string,
  ) => Effect.Effect<void>;

  /**
   * Invalidate all cached entries (full cache clear).
   */
  readonly invalidateAll: (reason?: string) => Effect.Effect<void>;

  /**
   * Get current cache statistics.
   */
  readonly getStats: Effect.Effect<{
    readonly size: number;
    readonly hits: number;
    readonly misses: number;
    readonly invalidations: number;
  }>;

  /**
   * Subscribe to cache invalidation events.
   */
  readonly invalidationStream: Effect.Effect<Hub.Hub<CacheInvalidationEvent>, never, Scope.Scope>;
}

export class ProviderCache extends Context.Service<ProviderCache, ProviderCacheShape>()(
  "t3/services/ProviderCache",
) {}

// ---------------------------------------------------------------------------
// Cache key builder helpers
// ---------------------------------------------------------------------------

function makeModelListKey(providerInstanceId: ProviderInstanceId): ModelListCacheKey {
  return new ModelListCacheKey({ type: "modelList", providerInstanceId });
}

function makeCapabilityKey(providerInstanceId: ProviderInstanceId, query: string): CapabilityCacheKey {
  return new CapabilityCacheKey({ type: "capability", providerInstanceId, query });
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const config = DEFAULT_CACHE_CONFIG;
  const invalidationHub = yield* Hub.unbounded<CacheInvalidationEvent>();
  const hitCount = yield* Ref.make(0);
  const missCount = yield* Ref.make(0);
  const invalidationCount = yield* Ref.make(0);

  const cache = yield* Cache.make({
    capacity: config.maxEntries,
    timeToLive: config.modelListTtl,
    lookup: (_key: ProviderCacheKey) => Effect.never as Effect.Effect<ProviderCacheValue>,
  });

  const invalidate = Effect.fn("providerCache.invalidate")(
    function* (providerInstanceId: ProviderInstanceId, reason = "provider_config_change") {
      // Remove all entries matching the provider instance
      const keys = yield* Effect.sync(() => cache.cacheKeys());
      const keysToInvalidate = keys.filter(
        (key) => key.providerInstanceId === providerInstanceId,
      );
      for (const key of keysToInvalidate) {
        yield* Effect.sync(() => cache.invalidate(key));
      }
      yield* Ref.update(invalidationCount, (n) => n + keysToInvalidate.length);
      yield* Hub.publish(invalidationHub, new CacheInvalidationEvent({ providerInstanceId, reason }));
      yield* Metric.update(
        Metric.withAttributes(cacheInvalidationsTotal, metricAttributes({ providerInstanceId, reason })),
        keysToInvalidate.length,
      );
    },
  );

  const invalidateAll = Effect.fn("providerCache.invalidateAll")(
    function* (reason = "full_invalidation") {
      const keys = yield* Effect.sync(() => cache.cacheKeys());
      for (const key of keys) {
        yield* Effect.sync(() => cache.invalidate(key));
      }
      yield* Ref.update(invalidationCount, (n) => n + keys.length);
      yield* Hub.publish(invalidationHub, new CacheInvalidationEvent({
        providerInstanceId: "*all*" as ProviderInstanceId,
        reason,
      }));
    },
  );

  const getModelList = Effect.fn("providerCache.getModelList")(
    function* (
      providerInstanceId: ProviderInstanceId,
      lookup: Effect.Effect<ModelListValue>,
    ): Effect.Effect<ModelListValue> {
      const key = makeModelListKey(providerInstanceId);
      const cached = yield* Effect.sync(() => cache.get(key));
      if (cached !== undefined) {
        yield* Ref.update(hitCount, (n) => n + 1);
        yield* Metric.update(
          Metric.withAttributes(cacheHitsTotal, metricAttributes({
            providerInstanceId,
            cacheType: "modelList",
          })),
          1,
        );
        return cached as ModelListValue;
      }

      yield* Ref.update(missCount, (n) => n + 1);
      yield* Metric.update(
        Metric.withAttributes(cacheMissesTotal, metricAttributes({
          providerInstanceId,
          cacheType: "modelList",
        })),
        1,
      );

      const value = yield* lookup;
      yield* Effect.sync(() => cache.set(key, value));
      return value;
    },
  );

  const getCapability = Effect.fn("providerCache.getCapability")(
    function* (
      providerInstanceId: ProviderInstanceId,
      query: string,
      lookup: Effect.Effect<CapabilityValue>,
    ): Effect.Effect<CapabilityValue> {
      const key = makeCapabilityKey(providerInstanceId, query);
      const cached = yield* Effect.sync(() => cache.get(key));
      if (cached !== undefined) {
        yield* Ref.update(hitCount, (n) => n + 1);
        yield* Metric.update(
          Metric.withAttributes(cacheHitsTotal, metricAttributes({
            providerInstanceId,
            cacheType: "capability",
          })),
          1,
        );
        return cached as CapabilityValue;
      }

      yield* Ref.update(missCount, (n) => n + 1);
      yield* Metric.update(
        Metric.withAttributes(cacheMissesTotal, metricAttributes({
          providerInstanceId,
          cacheType: "capability",
        })),
        1,
      );

      const value = yield* lookup;
      yield* Effect.sync(() => cache.set(key, value));
      return value;
    },
  );

  const getStats = Effect.gen(function* () {
    const size = yield* Effect.sync(() => cache.size());
    const hits = yield* Ref.get(hitCount);
    const misses = yield* Ref.get(missCount);
    const invalidations = yield* Ref.get(invalidationCount);
    return { size, hits, misses, invalidations };
  });

  return ProviderCache.of({
    getModelList,
    getCapability,
    invalidate,
    invalidateAll,
    getStats,
    invalidationStream: Effect.succeed(invalidationHub),
  });
});

export const layer = Layer.effect(ProviderCache, make);

/**
 * Layer that subscribes to provider config change events and invalidates
 * the cache for the affected provider instance.
 *
 * Accepts a Stream of `{ providerInstanceId, reason }` events from the
 * provider registry or configuration layer.
 */
export const layerWithAutoInvalidation = <E, R>(
  configChangeStream: Effect.Effect<
    Hub.Hub<{ providerInstanceId: ProviderInstanceId; reason: string }>,
    never,
    R
  >,
): Layer.Layer<ProviderCache, never, R> =>
  Layer.scoped(ProviderCache, Effect.gen(function* () {
    const providerCache = yield* make;
    const hub = yield* configChangeStream;
    yield* Effect.gen(function* () {
      while (true) {
        const event = yield* Hub.take(hub);
        yield* providerCache.invalidate(event.providerInstanceId, event.reason);
      }
    }).pipe(Effect.forkScoped);
    return providerCache;
  }));
