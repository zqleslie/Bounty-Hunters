/**
 * envValidation.ts - T3 Code 鐜鍙橀噺鏍￠獙妯″潡
 *
 * Uses Effect Schema to validate all T3CODE_* environment variables at startup.
 * Supports --validate-config CLI flag for config-only validation.
 */
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Either from "effect/Either";

// 鈹€鈹€鈹€ Types 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export interface VarEntry {
  name: string;
  required: boolean;
  value: string;
  status: "OK" | "ERROR";
  descriptionCn: string;
  description: string;
  errorDetail?: string;
  expectedType: string;
}

export interface ValidationResult {
  entries: VarEntry[];
  errors: VarEntry[];
  ok: boolean;
}

interface VarDef {
  name: string;
  schema: Schema.Schema.All;
  required: boolean;
  description: string;
  descriptionCn: string;
  default?: string;
  expectedType: string;
}

// 鈹€鈹€鈹€ Schema Helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const LogLevelSchema = Schema.Literal(
  "Trace", "Debug", "Info", "Warning", "Error", "Fatal", "None",
);

const ModeSchema = Schema.Literal("web", "desktop");

const PortSchema = EnvNumberSchema.pipe(
  Schema.filter((n) => n >= 1 && n <= 65535, {
    message: () => "must be between 1 and 65535",
  }),
);

// Boolean from env: accepts "true"/"false"/"1"/"0"
const EnvBooleanSchema = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transformOrFail({
      decode: (s, _, ast) => {
        if (s === "true" || s === "1") return Effect.succeed(true);
        if (s === "false" || s === "0") return Effect.succeed(false);
        return Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(s), {
            message: "Expected boolean string (true/false/1/0)",
          }),
        );
      },
      encode: (b) => Effect.succeed(b ? "true" : "false"),
    }),
  ),
);

// Number from string env var
const EnvNumberSchema = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Number,
    SchemaTransformation.transformOrFail({
      decode: (s, _, ast) => {
        const n = Number(s);
        if (Number.isNaN(n)) {
          return Effect.fail(
            new SchemaIssue.InvalidValue(Option.some(s), {
              message: "Expected a number",
            }),
          );
        }
        return Effect.succeed(n);
      },
      encode: (n) => Effect.succeed(String(n)),
    }),
  ),
);

const PositiveIntSchema = EnvNumberSchema.pipe(
  Schema.filter((n) => Number.isInteger(n) && n > 0, {
    message: () => "must be a positive integer",
  }),
);

const NonNegIntSchema = EnvNumberSchema.pipe(
  Schema.filter((n) => Number.isInteger(n) && n >= 0, {
    message: () => "must be a non-negative integer",
  }),
);

// URL validation via Schema.URLFromString
const EnvUrlSchema = Schema.URLFromString;

// 鈹€鈹€鈹€ Variable Definitions (all 22 vars, matching EnvServerConfig in cli/config.ts) 鈹€鈹€

const VAR_DEFS: VarDef[] = [
  {
    name: "T3CODE_LOG_LEVEL",
    schema: LogLevelSchema,
    required: false,
    default: "Info",
    description: "Minimum log level for server output",
    descriptionCn: "鏈嶅姟鍣ㄦ棩蹇楁渶浣庣骇鍒?,
    expectedType: "LogLevel",
  },
  {
    name: "T3CODE_TRACE_MIN_LEVEL",
    schema: LogLevelSchema,
    required: false,
    default: "Info",
    description: "Minimum trace level for diagnostics",
    descriptionCn: "璇婃柇杩借釜鏈€浣庣骇鍒?,
    expectedType: "LogLevel",
  },
  {
    name: "T3CODE_TRACE_TIMING_ENABLED",
    schema: EnvBooleanSchema,
    required: false,
    default: "true",
    description: "Enable trace timing measurements",
    descriptionCn: "鍚敤杩借釜璁℃椂",
    expectedType: "boolean",
  },
  {
    name: "T3CODE_TRACE_FILE",
    schema: Schema.String,
    required: false,
    description: "Trace output file path",
    descriptionCn: "杩借釜杈撳嚭鏂囦欢璺緞",
    expectedType: "string (path)",
  },
  {
    name: "T3CODE_TRACE_MAX_BYTES",
    schema: PositiveIntSchema,
    required: false,
    default: "10485760",
    description: "Max trace file size in bytes (default: 10MB)",
    descriptionCn: "杩借釜鏂囦欢鏈€澶уぇ灏忥紙瀛楄妭锛岄粯璁?10MB锛?,
    expectedType: "positive integer",
  },
  {
    name: "T3CODE_TRACE_MAX_FILES",
    schema: NonNegIntSchema,
    required: false,
    default: "10",
    description: "Max number of trace files to keep",
    descriptionCn: "淇濈暀鐨勬渶澶ц拷韪枃浠舵暟",
    expectedType: "non-negative integer",
  },
  {
    name: "T3CODE_TRACE_BATCH_WINDOW_MS",
    schema: PositiveIntSchema,
    required: false,
    default: "200",
    description: "Trace batch flush window in milliseconds",
    descriptionCn: "杩借釜鎵归噺鍒锋柊绐楀彛锛堟绉掞級",
    expectedType: "positive integer",
  },
  {
    name: "T3CODE_OTLP_TRACES_URL",
    schema: EnvUrlSchema,
    required: false,
    description: "OTLP traces endpoint URL",
    descriptionCn: "OTLP 杩借釜绔偣 URL",
    expectedType: "URL",
  },
  {
    name: "T3CODE_OTLP_METRICS_URL",
    schema: EnvUrlSchema,
    required: false,
    description: "OTLP metrics endpoint URL",
    descriptionCn: "OTLP 鎸囨爣绔偣 URL",
    expectedType: "URL",
  },
  {
    name: "T3CODE_OTLP_EXPORT_INTERVAL_MS",
    schema: PositiveIntSchema,
    required: false,
    default: "10000",
    description: "OTLP export interval in milliseconds",
    descriptionCn: "OTLP 瀵煎嚭闂撮殧锛堟绉掞級",
    expectedType: "positive integer",
  },
  {
    name: "T3CODE_OTLP_SERVICE_NAME",
    schema: Schema.String,
    required: false,
    default: "t3-server",
    description: "OTLP service name identifier",
    descriptionCn: "OTLP 鏈嶅姟鍚嶇О鏍囪瘑",
    expectedType: "string",
  },
  {
    name: "T3CODE_MODE",
    schema: ModeSchema,
    required: false,
    description: "Runtime mode: web or desktop",
    descriptionCn: "杩愯妯″紡锛歸eb 鎴?desktop",
    expectedType: "web | desktop",
  },
  {
    name: "T3CODE_PORT",
    schema: PortSchema,
    required: false,
    description: "Server listen port",
    descriptionCn: "鏈嶅姟鍣ㄧ洃鍚鍙?,
    expectedType: "number (1-65535)",
  },
  {
    name: "T3CODE_HOST",
    schema: Schema.String,
    required: false,
    description: "Server listen host/address",
    descriptionCn: "鏈嶅姟鍣ㄧ洃鍚湴鍧€",
    expectedType: "string",
  },
  {
    name: "T3CODE_HOME",
    schema: Schema.String,
    required: false,
    description: "CRITICAL: Base directory for T3 Code",
    descriptionCn: "鍏抽敭锛歍3 Code 鍩虹鐩綍",
    expectedType: "string (path)",
  },
  {
    name: "VITE_DEV_SERVER_URL",
    schema: EnvUrlSchema,
    required: false,
    description: "Vite dev server URL (development only)",
    descriptionCn: "Vite 寮€鍙戞湇鍔″櫒 URL锛堜粎寮€鍙戠幆澧冿級",
    expectedType: "URL",
  },
  {
    name: "T3CODE_NO_BROWSER",
    schema: EnvBooleanSchema,
    required: false,
    description: "Skip auto-opening browser on startup",
    descriptionCn: "鍚姩鏃朵笉鑷姩鎵撳紑娴忚鍣?,
    expectedType: "boolean",
  },
  {
    name: "T3CODE_BOOTSTRAP_FD",
    schema: EnvNumberSchema,
    required: false,
    description: "Bootstrap file descriptor (internal use)",
    descriptionCn: "寮曞鏂囦欢鎻忚堪绗︼紙鍐呴儴浣跨敤锛?,
    expectedType: "number",
  },
  {
    name: "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
    schema: EnvBooleanSchema,
    required: false,
    description: "Auto-bootstrap project from current working directory",
    descriptionCn: "浠庡綋鍓嶅伐浣滅洰褰曡嚜鍔ㄥ紩瀵奸」鐩?,
    expectedType: "boolean",
  },
  {
    name: "T3CODE_LOG_WS_EVENTS",
    schema: EnvBooleanSchema,
    required: false,
    description: "Log WebSocket events to console",
    descriptionCn: "灏?WebSocket 浜嬩欢璁板綍鍒版帶鍒跺彴",
    expectedType: "boolean",
  },
  {
    name: "T3CODE_TAILSCALE_SERVE",
    schema: EnvBooleanSchema,
    required: false,
    description: "Enable Tailscale serve integration",
    descriptionCn: "鍚敤 Tailscale serve 闆嗘垚",
    expectedType: "boolean",
  },
  {
    name: "T3CODE_TAILSCALE_SERVE_PORT",
    schema: PortSchema,
    required: false,
    description: "Tailscale serve port number",
    descriptionCn: "Tailscale serve 绔彛鍙?,
    expectedType: "number (1-65535)",
  },
];

// 鈹€鈹€鈹€ Core Validation 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function validateSingle(def: VarDef): Effect.Effect<VarEntry> {
  return Effect.gen(function* () {
    const raw = yield* Config.string(def.name).pipe(
      Config.withDefault(def.default ?? ""),
    );

    if (!raw || raw === "") {
      return {
        name: def.name,
        required: def.required,
        value: "(not set)",
        status: "OK" as const,
        descriptionCn: def.descriptionCn,
        description: def.description,
        expectedType: def.expectedType,
      } satisfies VarEntry;
    }

    return yield* Schema.decodeUnknown(def.schema)(raw).pipe(
      Effect.match({
        onSuccess: () => ({
          name: def.name,
          required: def.required,
          value: raw,
          status: "OK" as const,
          descriptionCn: def.descriptionCn,
          description: def.description,
          expectedType: def.expectedType,
        } as VarEntry),
        onFailure: (issue) => ({
          name: def.name,
          required: def.required,
          value: raw,
          status: "ERROR" as const,
          descriptionCn: def.descriptionCn,
          description: def.description,
          expectedType: def.expectedType,
          errorDetail: Schema.TreeFormatter.formatIssueSync(issue),
        } as VarEntry),
      }),
    );
  });
}

/**
 * Validate all T3CODE_* environment variables.
 * Returns ValidationResult with entries and any errors found.
 */
export function validateEnvVars(): Effect.Effect<ValidationResult> {
  return Effect.gen(function* () {
    const effects = VAR_DEFS.map((def) => validateSingle(def));
    const entries = yield* Effect.all(effects);
    const errors = entries.filter((e) => e.status === "ERROR");

    return {
      entries,
      errors,
      ok: errors.length === 0,
    } satisfies ValidationResult;
  });
}

// 鈹€鈹€鈹€ Table Formatting 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

/**
 * Format validation result as ASCII table.
 */
export function formatValidationTable(result: ValidationResult): string {
  const sep = "鈹€";
  const title = result.ok
    ? "Environment Variable Validation"
    : "Environment Variable Validation - ERRORS FOUND";
  const sepLine = sep.repeat(Math.max(title.length, 94));

  const lines: string[] = [
    title,
    "=".repeat(title.length),
    "",
  ];

  if (result.ok) {
    lines.push(
      padRight("Variable", 40) +
        padRight("Required", 10) +
        padRight("Value", 16) +
        padRight("Status", 8) +
        "Description",
      sepLine,
    );
    for (const entry of result.entries) {
      const isCritical = entry.name === "T3CODE_HOME";
      const displayName = isCritical
        ? "鈽?" + padRight(entry.name, 37)
        : "  " + padRight(entry.name, 37);
      lines.push(
        displayName +
          padRight(entry.required ? "yes" : "no", 10) +
          padRight(entry.value, 16) +
          padRight(entry.status, 8) +
          `${entry.descriptionCn} / ${entry.description}`,
      );
    }
  } else {
    lines.push(
      padRight("Variable", 36) +
        padRight("Required", 10) +
        padRight("Expected", 24) +
        padRight("Received", 14) +
        "Description",
      sepLine,
    );
    for (const entry of result.errors) {
      lines.push(
        padRight(entry.name, 36) +
          padRight(entry.required ? "yes" : "no", 10) +
          padRight(entry.expectedType, 24) +
          padRight(`"${entry.value}"`, 14) +
          `${entry.descriptionCn} / ${entry.errorDetail ?? ""}`,
      );
    }
    const okCount = result.entries.filter((e) => e.status === "OK").length;
    lines.push("");
    lines.push(`  (${result.errors.length} error(s) found, ${okCount} variable(s) passed)`);
  }

  return lines.join("\n");
}

/**
 * Print validation table to stdout.
 */
export function printValidationTable(
  result: ValidationResult,
): Effect.Effect<void> {
  return Effect.sync(() => {
    // eslint-disable-next-line no-console
    console.log(formatValidationTable(result));
  });
}

/**
 * Full validation + print + exit flow for --validate-config mode.
 * Exit 0 on success, exit 1 on error.
 */
export function validateAndExit(): Effect.Effect<void, never, never> {
  return validateEnvVars().pipe(
    Effect.flatMap((result) =>
      printValidationTable(result).pipe(
        Effect.zipRight(
          Effect.sync(() => {
            if (result.ok) {
              // eslint-disable-next-line no-console
              console.log("\nAll environment variables are valid.");
              // eslint-disable-next-line no-process-exit
              process.exit(0);
            } else {
              // eslint-disable-next-line no-console
              console.error(`\nValidation failed: ${result.errors.length} error(s)`);
              // eslint-disable-next-line no-process-exit
              process.exit(1);
            }
          }),
        ),
      ),
    ),
  );
}
