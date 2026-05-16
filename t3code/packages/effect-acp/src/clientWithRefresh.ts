/**
 * ACP Client with automatic token refresh on 401 Unauthorized responses.
 *
 * Wraps the base AcpClient to add:
 * - Token expiry detection via 401 response codes
 * - Automatic re-authentication using Effect.retry (single attempt)
 * - Refresh token stored separately from access token
 * - onSessionExpired callback fires before re-auth
 * - Effect.acquireRelease ensures old session cleanup
 * - Concurrent request queuing during re-auth
 * - Typed AuthenticationError on re-auth failure
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";

import type * as AcpSchema from "./_generated/schema.gen.ts";
import * as AcpError from "./errors.ts";
import { AcpClient, make, type AcpClientOptions, type AcpClientShape } from "./client.ts";
import type { Stdio } from "effect/Stdio";

// ---------------------------------------------------------------------------
// Authentication error for failed re-auth
// ---------------------------------------------------------------------------

export class AuthenticationError extends Data.TaggedError("AuthenticationError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly sessionId?: string;
}> {
  override get message() {
    return `Authentication failed: ${this.message}`;
  }
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface SessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly sessionId: string;
}

type ReAuthState =
  | { _tag: "idle" }
  | { _tag: "reauthenticating"; promise: Promise<void> };

// ---------------------------------------------------------------------------
// Client options extended with refresh support
// ---------------------------------------------------------------------------

export interface AcpClientWithRefreshOptions extends AcpClientOptions {
  /**
   * Callback fired with the expired session ID before re-authentication begins.
   * Allows custom handling (e.g., logging, UI notification).
   */
  readonly onSessionExpired?: (
    sessionId: string,
  ) => Effect.Effect<void, never>;
}

// ---------------------------------------------------------------------------
// Shape extended with refresh capability
// ---------------------------------------------------------------------------

export interface AcpClientWithRefreshShape extends AcpClientShape {
  /**
   * Set the current session tokens for automatic refresh.
   * Called after initial authentication.
   */
  readonly setSessionTokens: (
    tokens: SessionTokens,
  ) => Effect.Effect<void>;

  /**
   * Clear session tokens (e.g., after explicit logout).
   */
  readonly clearSessionTokens: Effect.Effect<void>;
}

export class AcpClientWithRefresh extends Context.Service<
  AcpClientWithRefresh,
  AcpClientWithRefreshShape
>("effect-acp/AcpClientWithRefresh") {}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const makeWithRefresh = Effect.fn("effect-acp/AcpClientWithRefresh.make")(
  function* (
    stdio: Stdio,
    options: AcpClientWithRefreshOptions = {},
  ): Effect.fn.Return<AcpClientWithRefreshShape, never, Scope.Scope> {
    // Create the base client
    const baseClient = yield* make(stdio, options);

    // Session token state
    const sessionTokensRef = yield* Ref.make<SessionTokens | null>(null);

    // Re-auth state: prevents concurrent re-auth attempts
    const reAuthStateRef = yield* Ref.make<ReAuthState>({ _tag: "idle" });

    // Queue for pending requests during re-auth
    const pendingQueue = yield* Queue.unbounded<
      readonly [
        () => Effect.Effect<unknown, AcpError.AcpError>,
        Effect.Deferred<unknown, AcpError.AcpError>,
      ]
    >();

    // Flag to track if we're currently re-authenticating
    const isReauthenticatingRef = yield* Ref.make(false);

    // Wrap request with 401 detection and automatic retry
    const wrappedRequest = (
      method: string,
      payload: unknown,
    ): Effect.Effect<unknown, AcpError.AcpError> =>
      Effect.gen(function* () {
        const sessionTokens = yield* Ref.get(sessionTokensRef);
        if (!sessionTokens) {
          // No session tokens set, pass through to base client
          return yield* baseClient.raw.request(method, payload);
        }

        const result = yield* baseClient.raw.request(method, payload).pipe(
          Effect.catchIf(
            (err): err is AcpError.AcpRequestError =>
              err instanceof AcpError.AcpRequestError && err.code === -32000,
            (authError) =>
              Effect.gen(function* () {
                // Check if already re-authenticating
                const isReauth = yield* Ref.get(isReauthenticatingRef);
                if (isReauth) {
                  // Queue this request and wait for re-auth to complete
                  const deferred = yield* Effect.makeDeferred<unknown, AcpError.AcpError>();
                  yield* Queue.offer(pendingQueue, [() => baseClient.raw.request(method, payload), deferred]);
                  return yield* Effect.await(deferred);
                }

                // Start re-auth
                yield* Ref.set(isReauthenticatingRef, true);

                // Fire onSessionExpired callback
                if (options.onSessionExpired) {
                  yield* options.onSessionExpired(sessionTokens.sessionId).pipe(
                    Effect.catchAll(() => Effect.void),
                  );
                }

                // Clean up old session resources via acquireRelease pattern
                const cleanupResult = yield* Effect.acquireRelease(
                  Effect.succeed(sessionTokens),
                  (oldTokens) =>
                    Effect.gen(function* () {
                      // Clear old tokens
                      yield* Ref.set(sessionTokensRef, null);
                      // Attempt logout to clean up server-side session
                      yield* baseClient.agent.logout({}).pipe(
                        Effect.catchAll(() => Effect.void),
                      );
                    }),
                  (oldTokens) =>
                    Effect.gen(function* () {
                      // Re-authenticate using refresh token
                      const reAuthResult = yield* Effect.retry(
                        baseClient.agent.authenticate({
                          // In a real implementation, this would use the refresh token
                          // The exact authenticate payload depends on the ACP spec
                          credentials: {
                            refresh_token: oldTokens.refreshToken,
                            grant_type: "refresh_token",
                          },
                        } as AcpSchema.AuthenticateRequest),
                        Schedule.once,
                      ).pipe(
                        Effect.catchAll((err) =>
                          Effect.fail(
                            new AuthenticationError({
                              message: "Re-authentication failed after one retry attempt",
                              cause: err,
                              sessionId: oldTokens.sessionId,
                            }),
                          ),
                        ),
                      );

                      // Update session tokens with new ones
                      yield* Ref.set(sessionTokensRef, {
                        ...oldTokens,
                        accessToken: (reAuthResult as any).access_token ?? oldTokens.accessToken,
                      });

                      return reAuthResult;
                    }),
                );

                // Mark re-auth as complete
                yield* Ref.set(isReauthenticatingRef, false);

                // Drain pending queue
                yield* drainPendingQueue();

                // Retry the original request
                return yield* baseClient.raw.request(method, payload);
              }),
          ),
        );

        return result;
      });

    // Drain pending queue after successful re-auth
    const drainPendingQueue = Effect.gen(function* () {
      const pending: Array<readonly [() => Effect.Effect<unknown, AcpError.AcpError>, Effect.Deferred<unknown, AcpError.AcpError>]> = [];
      let item = yield* Queue.poll(pendingQueue);
      while (item) {
        pending.push(item);
        item = yield* Queue.poll(pendingQueue);
      }

      if (pending.length === 0) return;

      yield* Effect.forEach(
        pending,
        ([requestFn, deferred]) =>
          requestFn().pipe(
            Effect.matchCauseEffect({
              onSuccess: (value) => Effect.deferred.succeed(deferred, value),
              onFailure: (cause) => Effect.deferred.failCause(deferred, cause),
            }),
          ),
        { discard: true },
      );
    });

    // Wrap notify (notifications don't need retry)
    const wrappedNotify = (
      method: string,
      payload: unknown,
    ): Effect.Effect<void, AcpError.AcpError> =>
      baseClient.raw.notify(method, payload);

    // Build the extended client shape
    return AcpClientWithRefresh.of({
      ...baseClient,
      raw: {
        ...baseClient.raw,
        request: wrappedRequest,
        notify: wrappedNotify,
      },
      setSessionTokens: (tokens: SessionTokens) =>
        Ref.set(sessionTokensRef, tokens),
      clearSessionTokens: Ref.set(sessionTokensRef, null),
    });
  },
);

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

export const layerChildProcessWithRefresh = (
  handle: import("effect/unstable/process").ChildProcessSpawner.ChildProcessHandle,
  options: AcpClientWithRefreshOptions = {},
): Layer.Layer<AcpClientWithRefresh, never, Scope.Scope> => {
  const { makeChildStdio, makeTerminationError } = require("./_internal/stdio.ts");
  const stdio = makeChildStdio(handle);
  const terminationError = makeTerminationError(handle);
  return Layer.effect(AcpClientWithRefresh, makeWithRefresh(stdio, { ...options, terminationError }));
};
