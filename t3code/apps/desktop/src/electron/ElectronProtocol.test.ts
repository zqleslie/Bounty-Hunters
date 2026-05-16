import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { beforeEach, vi } from "vitest";

const {
  registerFileProtocolMock,
  registerSchemesAsPrivilegedMock,
  unregisterProtocolMock,
  setAsDefaultProtocolClientMock,
  removeAsDefaultProtocolClientMock,
} = vi.hoisted(() => ({
  registerFileProtocolMock: vi.fn(),
  registerSchemesAsPrivilegedMock: vi.fn(),
  unregisterProtocolMock: vi.fn(),
  setAsDefaultProtocolClientMock: vi.fn(),
  removeAsDefaultProtocolClientMock: vi.fn(),
}));

vi.mock("electron", () => ({
  protocol: {
    registerFileProtocol: registerFileProtocolMock,
    registerSchemesAsPrivileged: registerSchemesAsPrivilegedMock,
    unregisterProtocol: unregisterProtocolMock,
  },
  app: {
    setAsDefaultProtocolClient: setAsDefaultProtocolClientMock,
    removeAsDefaultProtocolClient: removeAsDefaultProtocolClientMock,
  },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

describe("ElectronProtocol", () => {
  beforeEach(() => {
    registerFileProtocolMock.mockReset();
    registerSchemesAsPrivilegedMock.mockReset();
    unregisterProtocolMock.mockReset();
    setAsDefaultProtocolClientMock.mockReset();
    removeAsDefaultProtocolClientMock.mockReset();
  });

  it("normalizes safe desktop protocol pathnames", () => {
    assert.equal(
      Option.getOrNull(ElectronProtocol.normalizeDesktopProtocolPathname("/settings/./general")),
      "settings/general",
    );
    assert.isTrue(Option.isNone(ElectronProtocol.normalizeDesktopProtocolPathname("/../secret")));
  });

  it.effect("registers desktop scheme privileges through a layer", () =>
    Effect.scoped(
      Layer.build(ElectronProtocol.layerSchemePrivileges).pipe(
        Effect.andThen(
          Effect.sync(() => {
            assert.deepEqual(registerSchemesAsPrivilegedMock.mock.calls, [
              [
                [
                  {
                    scheme: "t3",
                    privileges: {
                      standard: true,
                      secure: true,
                      supportFetchAPI: true,
                      corsEnabled: true,
                    },
                  },
                ],
              ],
            ]);
          }),
        ),
      ),
    ),
  );

  it.effect("scopes registered file protocols", () =>
    Effect.gen(function* () {
      let capturedHandler:
        | ((
            request: Electron.ProtocolRequest,
            callback: (response: Electron.ProtocolResponse) => void,
          ) => void)
        | undefined;

      registerFileProtocolMock.mockImplementation((_scheme, handler) => {
        capturedHandler = handler;
        return true;
      });

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
          yield* electronProtocol.registerFileProtocol({
            scheme: "t3",
            handler: () => Effect.succeed({ path: "/app/index.html" }),
          });

          assert.isDefined(capturedHandler);
          return yield* Effect.callback<Electron.ProtocolResponse>((resume) => {
            capturedHandler?.({ url: "t3://app/" } as Electron.ProtocolRequest, (response) =>
              resume(Effect.succeed(response)),
            );
          });
        }),
      );

      assert.deepEqual(response, { path: "/app/index.html" });
      assert.deepEqual(
        registerFileProtocolMock.mock.calls.map((call) => call[0]),
        ["t3"],
      );
      assert.deepEqual(unregisterProtocolMock.mock.calls, [["t3"]]);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );
});

describe("DeepLink parsing", () => {
  it("parses open/project deep links", () => {
    const route = ElectronProtocol.parseDeepLinkUrl(
      "t3code://open/project?path=/path/to/repo",
    );
    assert.deepEqual(route, { type: "open", path: "/path/to/repo" });
  });

  it("parses chat/thread deep links", () => {
    const route = ElectronProtocol.parseDeepLinkUrl(
      "t3code://chat/thread?id=abc123",
    );
    assert.deepEqual(route, { type: "chat", threadId: "abc123" });
  });

  it("parses settings deep links", () => {
    const route = ElectronProtocol.parseDeepLinkUrl("t3code://settings");
    assert.deepEqual(route, { type: "settings" });
  });

  it("rejects path traversal in open links", () => {
    const route = ElectronProtocol.parseDeepLinkUrl(
      "t3code://open/project?path=/path/to/../secret",
    );
    assert.equal(route.type, "unknown");
  });

  it("rejects tilde paths in open links", () => {
    const route = ElectronProtocol.parseDeepLinkUrl(
      "t3code://open/project?path=~/secret",
    );
    assert.equal(route.type, "unknown");
  });

  it("rejects URLs with special characters", () => {
    const route = ElectronProtocol.parseDeepLinkUrl(
      't3code://open/project?path=/path/to/<script>',
    );
    assert.equal(route.type, "unknown");
  });

  it("returns unknown for missing path parameter", () => {
    const route = ElectronProtocol.parseDeepLinkUrl("t3code://open/project");
    assert.equal(route.type, "unknown");
  });

  it("returns unknown for missing thread id", () => {
    const route = ElectronProtocol.parseDeepLinkUrl("t3code://chat/thread");
    assert.equal(route.type, "unknown");
  });

  it("returns unknown for unrecognised host", () => {
    const route = ElectronProtocol.parseDeepLinkUrl("t3code://unknown/action");
    assert.equal(route.type, "unknown");
  });

  it("returns unknown for malformed URLs", () => {
    const route = ElectronProtocol.parseDeepLinkUrl("not-a-url");
    assert.equal(route.type, "unknown");
  });

  it("handles case-insensitive hosts", () => {
    const route = ElectronProtocol.parseDeepLinkUrl(
      "t3code://OPEN/project?path=/path/to/repo",
    );
    assert.deepEqual(route, { type: "open", path: "/path/to/repo" });
  });
});
