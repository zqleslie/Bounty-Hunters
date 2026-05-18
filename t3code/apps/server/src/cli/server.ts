import * as Effect from "effect/Effect";
import { Command, GlobalFlag } from "effect/unstable/cli";
import * as Option from "effect/Option";

import { ServerConfig, type StartupPresentation, type RuntimeMode } from "../config.ts";
import { formatValidationReport, validateEnvSync } from "../envValidation.ts";
import { runServer } from "../server.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

const handleValidateConfig = (flags: CliServerFlags): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const validateConfig = flags.validateConfig ?? Option.none();
    if (!Option.getOrElse(validateConfig, () => false)) {
      return;
    }

    // Run sync validation first (before Effect runtime is fully initialised)
    const report = validateEnvSync();
    const formatted = formatValidationReport(report);
    yield* Effect.log(formatted);

    if (!report.ok) {
      // Exit with code 1 — validation failed
      yield* Effect.die(
        `Environment variable validation failed. See report above for details.`,
      );
      return;
    }

    // All valid — exit with code 0
    yield* Effect.log("All environment variables are valid.");
    yield* Effect.die("validate-config: all checks passed");
  });

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;

    // Handle --validate-config before resolving full server config
    yield* handleValidateConfig(flags);

    const config = yield* resolveServerConfig(flags, logLevel, options);
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the T3 Code server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
