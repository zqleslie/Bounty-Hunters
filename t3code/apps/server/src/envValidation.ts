/**
 * Environment variable validation at server startup.
 *
 * Validates all T3CODE_* environment variables against an Effect Schema,
 * producing a formatted table of missing, invalid, or valid values.
 *
 * @module envValidation
 */
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

const PortSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.lessThanOrEqualTo(65535),
  Schema.identifier("Port"),
);

const LogLevelSchema = Schema.Literal(
  "All",
  "Trace",
  "Debug",
  "Info",
  "Warning",
  "Error",
  "Fatal",
  "None",
);

const RuntimeModeSchema = Schema.Literal("web", "desktop");

/** Required env var descriptor */
export interface EnvVarDescriptor {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly defaultValue: string | undefined;
}

/** Individual validation result */
export interface EnvVarValidationResult {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly status: "valid" | "missing" | "invalid" | "default";
  readonly value: string | undefined;
  readonly expectedType: string;
  readonly error: string | undefined;
  readonly descriptor?: EnvVarDescriptor;
}

/** Full validation report */
export interface EnvValidationReport {
  readonly results: ReadonlyArray<EnvVarValidationResult>;
  readonly ok: boolean;
}

// ---------------------------------------------------------------------------
// Env var schema entries
// ---------------------------------------------------------------------------

interface EnvVarSchemaEntry {
  readonly descriptor: EnvVarDescriptor;
  readonly expectedType: string;
  readonly schema: Schema.Schema<any, any, never>;
}

const ENV_VAR_SCHEMAS: ReadonlyArray<EnvVarSchemaEntry> = [
  {
    descriptor: { name: "T3CODE_LOG_LEVEL", description: "Server log level", required: false, defaultValue: "Info" },
    expectedType: "LogLevel (All|Trace|Debug|Info|Warning|Error|Fatal|None)",
    schema: LogLevelSchema,
  },
  {
    descriptor: { name: "T3CODE_TRACE_MIN_LEVEL", description: "Minimum trace level", required: false, defaultValue: "Info" },
    expectedType: "LogLevel (All|Trace|Debug|Info|Warning|Error|Fatal|None)",
    schema: LogLevelSchema,
  },
  {
    descriptor: { name: "T3CODE_TRACE_TIMING_ENABLED", description: "Enable trace timing", required: false, defaultValue: "true" },
    expectedType: "boolean",
    schema: Schema.Boolean,
  },
  {
    descriptor: { name: "T3CODE_TRACE_FILE", description: "Custom trace file path", required: false, defaultValue: undefined },
    expectedType: "string (file path)",
    schema: Schema.String,
  },
  {
    descriptor: { name: "T3CODE_TRACE_MAX_BYTES", description: "Max trace file size in bytes", required: false, defaultValue: String(10 * 1024 * 1024) },
    expectedType: "integer",
    schema: Schema.Number.pipe(Schema.int(), Schema.positive()),
  },
  {
    descriptor: { name: "T3CODE_TRACE_MAX_FILES", description: "Max trace files to keep", required: false, defaultValue: "10" },
    expectedType: "integer",
    schema: Schema.Number.pipe(Schema.int(), Schema.positive()),
  },
  {
    descriptor: { name: "T3CODE_TRACE_BATCH_WINDOW_MS", description: "Trace batch window in milliseconds", required: false, defaultValue: "200" },
    expectedType: "integer",
    schema: Schema.Number.pipe(Schema.int(), Schema.positive()),
  },
  {
    descriptor: { name: "T3CODE_OTLP_TRACES_URL", description: "OTLP traces export URL", required: false, defaultValue: undefined },
    expectedType: "URL",
    schema: Schema.URL,
  },
  {
    descriptor: { name: "T3CODE_OTLP_METRICS_URL", description: "OTLP metrics export URL", required: false, defaultValue: undefined },
    expectedType: "URL",
    schema: Schema.URL,
  },
  {
    descriptor: { name: "T3CODE_OTLP_EXPORT_INTERVAL_MS", description: "OTLP export interval in milliseconds", required: false, defaultValue: "10000" },
    expectedType: "integer",
    schema: Schema.Number.pipe(Schema.int(), Schema.positive()),
  },
  {
    descriptor: { name: "T3CODE_OTLP_SERVICE_NAME", description: "OTLP service name", required: false, defaultValue: "t3-server" },
    expectedType: "string",
    schema: Schema.String,
  },
  {
    descriptor: { name: "T3CODE_MODE", description: "Runtime mode", required: false, defaultValue: "web" },
    expectedType: "web | desktop",
    schema: RuntimeModeSchema,
  },
  {
    descriptor: { name: "T3CODE_PORT", description: "HTTP server port", required: false, defaultValue: undefined },
    expectedType: "port (1-65535)",
    schema: PortSchema,
  },
  {
    descriptor: { name: "T3CODE_HOST", description: "Host/interface to bind", required: false, defaultValue: undefined },
    expectedType: "string (hostname or IP)",
    schema: Schema.String,
  },
  {
    descriptor: { name: "T3CODE_HOME", description: "Base data directory", required: false, defaultValue: undefined },
    expectedType: "string (directory path)",
    schema: Schema.String,
  },
  {
    descriptor: { name: "VITE_DEV_SERVER_URL", description: "Dev server URL for proxy", required: false, defaultValue: undefined },
    expectedType: "URL",
    schema: Schema.URL,
  },
  {
    descriptor: { name: "T3CODE_NO_BROWSER", description: "Disable automatic browser opening", required: false, defaultValue: undefined },
    expectedType: "boolean",
    schema: Schema.Boolean,
  },
  {
    descriptor: { name: "T3CODE_BOOTSTRAP_FD", description: "File descriptor for bootstrap secrets", required: false, defaultValue: undefined },
    expectedType: "integer",
    schema: Schema.Number.pipe(Schema.int(), Schema.positive()),
  },
  {
    descriptor: { name: "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD", description: "Auto-create project from CWD on startup", required: false, defaultValue: undefined },
    expectedType: "boolean",
    schema: Schema.Boolean,
  },
  {
    descriptor: { name: "T3CODE_LOG_WS_EVENTS", description: "Log WebSocket events to server logs", required: false, defaultValue: undefined },
    expectedType: "boolean",
    schema: Schema.Boolean,
  },
  {
    descriptor: { name: "T3CODE_TAILSCALE_SERVE", description: "Enable Tailscale Serve for HTTPS exposure", required: false, defaultValue: undefined },
    expectedType: "boolean",
    schema: Schema.Boolean,
  },
  {
    descriptor: { name: "T3CODE_TAILSCALE_SERVE_PORT", description: "HTTPS port for Tailscale Serve", required: false, defaultValue: "443" },
    expectedType: "port (1-65535)",
    schema: PortSchema,
  },
];

// ---------------------------------------------------------------------------
// Validation logic
// ---------------------------------------------------------------------------

const validateSingleEnvVar = (entry: EnvVarSchemaEntry): Effect.Effect<EnvVarValidationResult> =>
  Effect.gen(function* () {
    const config = Config.string(entry.descriptor.name).pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );
    const rawValue = yield* config;

    if (rawValue === undefined) {
      if (entry.descriptor.defaultValue !== undefined) {
        return {
          name: entry.descriptor.name,
          description: entry.descriptor.description,
          required: entry.descriptor.required,
          status: "default",
          value: undefined,
          expectedType: entry.expectedType,
          error: undefined,
        };
      }
      return {
        name: entry.descriptor.name,
        description: entry.descriptor.description,
        required: entry.descriptor.required,
        status: "missing",
        value: undefined,
        expectedType: entry.expectedType,
        error: undefined,
      };
    }

    const validationResult = yield* Schema.decodeUnknown(Effect.succeed(entry.schema))(
      rawValue,
    ).pipe(
      Effect.map(() => true as const),
      Effect.catchAll(() => Effect.succeed(false as const)),
    );

    if (!validationResult) {
      return {
        name: entry.descriptor.name,
        description: entry.descriptor.description,
        required: entry.descriptor.required,
        status: "invalid",
        value: rawValue,
        expectedType: entry.expectedType,
        error: `Value "${rawValue}" does not match expected type`,
      };
    }

    return {
      name: entry.descriptor.name,
      description: entry.descriptor.description,
      required: entry.descriptor.required,
      status: "valid",
      value: rawValue,
      expectedType: entry.expectedType,
      error: undefined,
    };
  });

/**
 * Validate all environment variables and return a report.
 */
export const validateEnvVars: Effect.Effect<EnvValidationReport> = Effect.gen(function* () {
  const results = yield* Effect.all(
    ENV_VAR_SCHEMAS.map(validateSingleEnvVar),
    { concurrency: "unbounded" },
  );

  const hasErrors = results.some((r) => r.status === "invalid");
  const hasRequiredMissing = results.some((r) => r.required && r.status === "missing");

  return {
    results,
    ok: !hasErrors && !hasRequiredMissing,
  };
});

// ---------------------------------------------------------------------------
// Formatted table output
// ---------------------------------------------------------------------------

const padRight = (str: string, width: number): string => {
  if (str.length >= width) return str.slice(0, width);
  return str + " ".repeat(width - str.length);
};

const statusIcon = (status: EnvVarValidationResult["status"]): string => {
  switch (status) {
    case "valid": return "✓";
    case "invalid": return "✗";
    case "missing": return "○";
    case "default": return "◎";
  }
};

/**
 * Format the validation report as a human-readable table.
 */
export const formatValidationReport = (report: EnvValidationReport): string => {
  const lines: string[] = [];

  lines.push("");
  lines.push("T3 Code Environment Variable Validation Report");
  lines.push("=".repeat(50));
  lines.push("");

  const nameWidth = 40;
  const statusWidth = 10;
  const valueWidth = 30;
  const expectedWidth = 30;

  lines.push(
    padRight("VARIABLE", nameWidth) +
      "  " +
      padRight("STATUS", statusWidth) +
      "  " +
      padRight("VALUE", valueWidth) +
      "  " +
      padRight("EXPECTED TYPE", expectedWidth) +
      "  " +
      "DESCRIPTION",
  );
  lines.push("-".repeat(120));

  for (const result of report.results) {
    const valueDisplay =
      result.status === "default"
        ? `(default: ${result.descriptor?.defaultValue ?? "—"})`
        : result.status === "missing"
          ? "(not set)"
          : result.status === "invalid"
            ? `⚠ ${result.value ?? ""}`
            : result.value ?? "";

    lines.push(
      padRight(result.name, nameWidth) +
        "  " +
        padRight(statusIcon(result.status), statusWidth) +
        "  " +
        padRight(valueDisplay, valueWidth) +
        "  " +
        padRight(result.expectedType, expectedWidth) +
        "  " +
        result.description,
    );

    if (result.error) {
      lines.push(`    Error: ${result.error}`);
    }
  }

  lines.push("");
  lines.push("-".repeat(120));
  const validCount = report.results.filter((r) => r.status === "valid").length;
  const invalidCount = report.results.filter((r) => r.status === "invalid").length;
  const missingCount = report.results.filter((r) => r.status === "missing").length;
  const defaultCount = report.results.filter((r) => r.status === "default").length;

  lines.push(
    `Summary: ${validCount} valid, ${defaultCount} using defaults, ${missingCount} missing, ${invalidCount} invalid`,
  );
  lines.push(
    `Legend: ✓ valid  |  ◎ using default  |  ○ not set (optional)  |  ✗ invalid`,
  );

  if (!report.ok) {
    lines.push("");
    lines.push("❌ Validation failed. Please fix the errors above before starting the server.");
  } else {
    lines.push("");
    lines.push("✅ All environment variables are valid.");
  }

  lines.push("");
  return lines.join("\n");
};

/**
 * Run validation and print the report.
 */
export const runValidation = Effect.gen(function* () {
  const report = yield* validateEnvVars;
  const formatted = formatValidationReport(report);

  yield* Console.log(formatted);

  if (!report.ok) {
    return yield* Effect.fail(report);
  }

  return report;
});

/**
 * Run validation via the raw process.env object (no Effect runtime needed).
 * Useful for the --validate-config flag which runs before the Effect runtime
 * is fully initialised.
 */
export function validateEnvSync(): EnvValidationReport {
  const results: EnvVarValidationResult[] = [];

  for (const entry of ENV_VAR_SCHEMAS) {
    const rawValue = process.env[entry.descriptor.name];

    if (rawValue === undefined) {
      results.push({
        name: entry.descriptor.name,
        description: entry.descriptor.description,
        required: entry.descriptor.required,
        status: entry.descriptor.defaultValue !== undefined ? "default" : "missing",
        value: undefined,
        expectedType: entry.expectedType,
        error: undefined,
        descriptor: entry.descriptor,
      });
      continue;
    }

    let isValid = true;
    let error: string | undefined;

    if (entry.expectedType.includes("boolean")) {
      if (!["true", "false"].includes(rawValue.toLowerCase())) {
        isValid = false;
        error = `Value "${rawValue}" is not a valid boolean (expected: true or false)`;
      }
    } else if (entry.expectedType.includes("integer")) {
      const num = Number(rawValue);
      if (!Number.isInteger(num)) {
        isValid = false;
        error = `Value "${rawValue}" is not a valid integer`;
      } else if (num <= 0) {
        isValid = false;
        error = `Value "${rawValue}" must be positive`;
      }
    } else if (entry.expectedType.includes("port")) {
      const num = Number(rawValue);
      if (!Number.isInteger(num) || num < 1 || num > 65535) {
        isValid = false;
        error = `Value "${rawValue}" is not a valid port (1-65535)`;
      }
    } else if (entry.expectedType.includes("URL")) {
      try {
        new URL(rawValue);
      } catch {
        isValid = false;
        error = `Value "${rawValue}" is not a valid URL`;
      }
    } else if (entry.expectedType.includes("LogLevel")) {
      const validLevels = ["All", "Trace", "Debug", "Info", "Warning", "Error", "Fatal", "None"];
      if (!validLevels.includes(rawValue)) {
        isValid = false;
        error = `Value "${rawValue}" is not a valid LogLevel`;
      }
    } else if (entry.expectedType.includes("web | desktop")) {
      if (!["web", "desktop"].includes(rawValue)) {
        isValid = false;
        error = `Value "${rawValue}" is not a valid mode (expected: web or desktop)`;
      }
    }

    results.push({
      name: entry.descriptor.name,
      description: entry.descriptor.description,
      required: entry.descriptor.required,
      status: isValid ? "valid" : "invalid",
      value: rawValue,
      expectedType: entry.expectedType,
      error,
      descriptor: entry.descriptor,
    });
  }

  const hasErrors = results.some((r) => r.status === "invalid");
  const hasRequiredMissing = results.some((r) => r.required && r.status === "missing");

  return { results, ok: !hasErrors && !hasRequiredMissing };
}
