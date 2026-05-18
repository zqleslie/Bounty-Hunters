import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  formatValidationReport,
  validateEnvSync,
  validateEnvVars,
  type EnvValidationReport,
} from "../envValidation.ts";

it.describe("envValidation", () => {
  it.effect("validateEnvVars returns ok when no env vars are set", () =>
    Effect.gen(function* () {
      const report = yield* validateEnvVars;
      assert.isTrue(report.ok);
    }),
  );

  it.effect("validateEnvVars marks values as valid when env vars are correctly set", () =>
    Effect.gen(function* () {
      process.env.T3CODE_LOG_LEVEL = "Debug";
      process.env.T3CODE_MODE = "desktop";
      process.env.T3CODE_NO_BROWSER = "true";
      process.env.T3CODE_PORT = "8080";

      try {
        const report = yield* validateEnvVars;
        const logLevelResult = report.results.find((r) => r.name === "T3CODE_LOG_LEVEL");
        const modeResult = report.results.find((r) => r.name === "T3CODE_MODE");

        expect(logLevelResult?.status).toBe("valid");
        expect(logLevelResult?.value).toBe("Debug");
        expect(modeResult?.status).toBe("valid");
        expect(modeResult?.value).toBe("desktop");
      } finally {
        delete process.env.T3CODE_LOG_LEVEL;
        delete process.env.T3CODE_MODE;
        delete process.env.T3CODE_NO_BROWSER;
        delete process.env.T3CODE_PORT;
      }
    }),
  );

  it.effect("validateEnvVars detects invalid log level", () =>
    Effect.gen(function* () {
      process.env.T3CODE_LOG_LEVEL = "INVALID";
      try {
        const report = yield* validateEnvVars;
        const logLevelResult = report.results.find((r) => r.name === "T3CODE_LOG_LEVEL");
        expect(logLevelResult?.status).toBe("invalid");
        assert.isFalse(report.ok);
      } finally {
        delete process.env.T3CODE_LOG_LEVEL;
      }
    }),
  );

  it.effect("validateEnvVars detects invalid port", () =>
    Effect.gen(function* () {
      process.env.T3CODE_PORT = "99999";
      try {
        const report = yield* validateEnvVars;
        const portResult = report.results.find((r) => r.name === "T3CODE_PORT");
        expect(portResult?.status).toBe("invalid");
        assert.isFalse(report.ok);
      } finally {
        delete process.env.T3CODE_PORT;
      }
    }),
  );

  it.effect("validateEnvVars detects invalid boolean", () =>
    Effect.gen(function* () {
      process.env.T3CODE_NO_BROWSER = "yes";
      try {
        const report = yield* validateEnvVars;
        const result = report.results.find((r) => r.name === "T3CODE_NO_BROWSER");
        expect(result?.status).toBe("invalid");
        assert.isFalse(report.ok);
      } finally {
        delete process.env.T3CODE_NO_BROWSER;
      }
    }),
  );

  it.effect("validateEnvVars detects invalid mode", () =>
    Effect.gen(function* () {
      process.env.T3CODE_MODE = "cloud";
      try {
        const report = yield* validateEnvVars;
        const result = report.results.find((r) => r.name === "T3CODE_MODE");
        expect(result?.status).toBe("invalid");
        assert.isFalse(report.ok);
      } finally {
        delete process.env.T3CODE_MODE;
      }
    }),
  );

  it.effect("validateEnvVars detects invalid URL", () =>
    Effect.gen(function* () {
      process.env.T3CODE_OTLP_TRACES_URL = "not-a-url";
      try {
        const report = yield* validateEnvVars;
        const result = report.results.find((r) => r.name === "T3CODE_OTLP_TRACES_URL");
        expect(result?.status).toBe("invalid");
        assert.isFalse(report.ok);
      } finally {
        delete process.env.T3CODE_OTLP_TRACES_URL;
      }
    }),
  );

  it.effect("validateEnvVars accepts valid URLs", () =>
    Effect.gen(function* () {
      process.env.T3CODE_OTLP_TRACES_URL = "http://localhost:4318/v1/traces";
      try {
        const report = yield* validateEnvVars;
        const result = report.results.find((r) => r.name === "T3CODE_OTLP_TRACES_URL");
        expect(result?.status).toBe("valid");
        assert.isTrue(report.ok);
      } finally {
        delete process.env.T3CODE_OTLP_TRACES_URL;
      }
    }),
  );
});

it.describe("validateEnvSync", () => {
  it("returns ok when no env vars are set", () => {
    assert.isTrue(validateEnvSync().ok);
  });

  it("detects invalid port", () => {
    process.env.T3CODE_PORT = "99999";
    try {
      const report = validateEnvSync();
      expect(report.results.find((r) => r.name === "T3CODE_PORT")?.status).toBe("invalid");
      assert.isFalse(report.ok);
    } finally {
      delete process.env.T3CODE_PORT;
    }
  });

  it("detects invalid boolean", () => {
    process.env.T3CODE_NO_BROWSER = "maybe";
    try {
      const report = validateEnvSync();
      expect(report.results.find((r) => r.name === "T3CODE_NO_BROWSER")?.status).toBe("invalid");
      assert.isFalse(report.ok);
    } finally {
      delete process.env.T3CODE_NO_BROWSER;
    }
  });

  it("detects invalid URL", () => {
    process.env.T3CODE_OTLP_METRICS_URL = "::::";
    try {
      const report = validateEnvSync();
      expect(report.results.find((r) => r.name === "T3CODE_OTLP_METRICS_URL")?.status).toBe("invalid");
      assert.isFalse(report.ok);
    } finally {
      delete process.env.T3CODE_OTLP_METRICS_URL;
    }
  });

  it("detects invalid log level", () => {
    process.env.T3CODE_LOG_LEVEL = "LOUD";
    try {
      const report = validateEnvSync();
      expect(report.results.find((r) => r.name === "T3CODE_LOG_LEVEL")?.status).toBe("invalid");
      assert.isFalse(report.ok);
    } finally {
      delete process.env.T3CODE_LOG_LEVEL;
    }
  });

  it("detects invalid mode", () => {
    process.env.T3CODE_MODE = "serverless";
    try {
      const report = validateEnvSync();
      expect(report.results.find((r) => r.name === "T3CODE_MODE")?.status).toBe("invalid");
      assert.isFalse(report.ok);
    } finally {
      delete process.env.T3CODE_MODE;
    }
  });

  it("accepts all valid env vars", () => {
    process.env.T3CODE_LOG_LEVEL = "Debug";
    process.env.T3CODE_MODE = "desktop";
    process.env.T3CODE_PORT = "3000";
    process.env.T3CODE_NO_BROWSER = "true";
    process.env.T3CODE_OTLP_TRACES_URL = "http://localhost:4318/v1/traces";
    try {
      assert.isTrue(validateEnvSync().ok);
    } finally {
      delete process.env.T3CODE_LOG_LEVEL;
      delete process.env.T3CODE_MODE;
      delete process.env.T3CODE_PORT;
      delete process.env.T3CODE_NO_BROWSER;
      delete process.env.T3CODE_OTLP_TRACES_URL;
    }
  });
});

it.describe("formatValidationReport", () => {
  it("produces a table with header and summary", () => {
    const report: EnvValidationReport = {
      results: [
        {
          name: "T3CODE_LOG_LEVEL",
          description: "Server log level",
          required: false,
          status: "valid",
          value: "Debug",
          expectedType: "LogLevel",
          error: undefined,
        },
        {
          name: "T3CODE_PORT",
          description: "HTTP server port",
          required: false,
          status: "missing",
          value: undefined,
          expectedType: "port (1-65535)",
          error: undefined,
        },
      ],
      ok: true,
    };

    const formatted = formatValidationReport(report);
    expect(formatted).toContain("VARIABLE");
    expect(formatted).toContain("STATUS");
    expect(formatted).toContain("EXPECTED TYPE");
    expect(formatted).toContain("DESCRIPTION");
    expect(formatted).toContain("T3CODE_LOG_LEVEL");
    expect(formatted).toContain("Summary:");
    expect(formatted).toContain("All environment variables are valid.");
  });

  it("includes error details for invalid values", () => {
    const report: EnvValidationReport = {
      results: [
        {
          name: "T3CODE_PORT",
          description: "HTTP server port",
          required: false,
          status: "invalid",
          value: "99999",
          expectedType: "port (1-65535)",
          error: 'Value "99999" does not match expected type',
        },
      ],
      ok: false,
    };

    const formatted = formatValidationReport(report);
    expect(formatted).toContain("✗");
    expect(formatted).toContain("Error:");
    expect(formatted).toContain("Validation failed");
  });

  it("shows default values for vars using defaults", () => {
    const report: EnvValidationReport = {
      results: [
        {
          name: "T3CODE_LOG_LEVEL",
          description: "Server log level",
          required: false,
          status: "default",
          value: undefined,
          expectedType: "LogLevel",
          error: undefined,
          descriptor: {
            name: "T3CODE_LOG_LEVEL",
            description: "Server log level",
            required: false,
            defaultValue: "Info",
          },
        },
      ],
      ok: true,
    };

    const formatted = formatValidationReport(report);
    expect(formatted).toContain("default: Info");
  });
});
