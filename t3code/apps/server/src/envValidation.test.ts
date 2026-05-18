/**
 * envValidation.test.ts - Tests for environment variable validation.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { validateEnvVars, formatValidationTable, ValidationResult } from "./envValidation.ts";

// Helper: run an Effect synchronously for testing
function runEffect<A>(effect: Effect.Effect<A>): A {
  return Effect.runSync(Effect.suspend(() => effect));
}

describe("validateEnvVars", () => {
  beforeEach(() => {
    // Clear T3CODE_* env vars before each test
    const keys = Object.keys(process.env).filter((k) => k.startsWith("T3CODE_") || k === "VITE_DEV_SERVER_URL");
    keys.forEach((k) => delete process.env[k]);
  });

  it("all vars OK when empty env (defaults apply)", () => {
    const result = runEffect(validateEnvVars());
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it("valid MODE passes", () => {
    process.env.T3CODE_MODE = "desktop";
    const result = runEffect(validateEnvVars());
    const modeEntry = result.entries.find((e) => e.name === "T3CODE_MODE");
    expect(modeEntry?.status).toBe("OK");
  });

  it("invalid MODE fails", () => {
    process.env.T3CODE_MODE = "foo";
    const result = runEffect(validateEnvVars());
    const modeEntry = result.entries.find((e) => e.name === "T3CODE_MODE");
    expect(modeEntry?.status).toBe("ERROR");
    expect(result.ok).toBe(false);
  });

  it("invalid PORT fails", () => {
    process.env.T3CODE_PORT = "abc";
    const result = runEffect(validateEnvVars());
    const portEntry = result.entries.find((e) => e.name === "T3CODE_PORT");
    expect(portEntry?.status).toBe("ERROR");
  });

  it("out-of-range PORT fails", () => {
    process.env.T3CODE_PORT = "99999";
    const result = runEffect(validateEnvVars());
    const portEntry = result.entries.find((e) => e.name === "T3CODE_PORT");
    expect(portEntry?.status).toBe("ERROR");
  });

  it("valid PORT passes", () => {
    process.env.T3CODE_PORT = "8080";
    const result = runEffect(validateEnvVars());
    const portEntry = result.entries.find((e) => e.name === "T3CODE_PORT");
    expect(portEntry?.status).toBe("OK");
  });

  it("invalid OTLP URL fails", () => {
    process.env.T3CODE_OTLP_TRACES_URL = "not-a-valid-url";
    const result = runEffect(validateEnvVars());
    const urlEntry = result.entries.find((e) => e.name === "T3CODE_OTLP_TRACES_URL");
    expect(urlEntry?.status).toBe("ERROR");
  });

  it("valid OTLP URL passes", () => {
    process.env.T3CODE_OTLP_TRACES_URL = "http://localhost:4318/v1/traces";
    const result = runEffect(validateEnvVars());
    const urlEntry = result.entries.find((e) => e.name === "T3CODE_OTLP_TRACES_URL");
    expect(urlEntry?.status).toBe("OK");
  });

  it("invalid boolean fails", () => {
    process.env.T3CODE_NO_BROWSER = "yes";
    const result = runEffect(validateEnvVars());
    const entry = result.entries.find((e) => e.name === "T3CODE_NO_BROWSER");
    expect(entry?.status).toBe("ERROR");
  });

  it("valid boolean passes (true)", () => {
    process.env.T3CODE_NO_BROWSER = "true";
    const result = runEffect(validateEnvVars());
    const entry = result.entries.find((e) => e.name === "T3CODE_NO_BROWSER");
    expect(entry?.status).toBe("OK");
  });

  it("valid boolean passes (false)", () => {
    process.env.T3CODE_NO_BROWSER = "false";
    const result = runEffect(validateEnvVars());
    const entry = result.entries.find((e) => e.name === "T3CODE_NO_BROWSER");
    expect(entry?.status).toBe("OK");
  });

  it("valid boolean passes (1/0)", () => {
    process.env.T3CODE_LOG_WS_EVENTS = "1";
    const result = runEffect(validateEnvVars());
    const entry = result.entries.find((e) => e.name === "T3CODE_LOG_WS_EVENTS");
    expect(entry?.status).toBe("OK");
  });

  it("multiple errors collected simultaneously", () => {
    process.env.T3CODE_MODE = "invalid";
    process.env.T3CODE_PORT = "99999";
    process.env.T3CODE_OTLP_TRACES_URL = "nope";
    const result = runEffect(validateEnvVars());
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    expect(result.ok).toBe(false);
  });

  it("invalid LOG_LEVEL fails", () => {
    process.env.T3CODE_LOG_LEVEL = "VERBOSE";
    const result = runEffect(validateEnvVars());
    const entry = result.entries.find((e) => e.name === "T3CODE_LOG_LEVEL");
    expect(entry?.status).toBe("ERROR");
  });
});

describe("formatValidationTable", () => {
  it("formats success table", () => {
    const result: ValidationResult = {
      entries: [
        {
          name: "T3CODE_MODE",
          required: false,
          value: "web",
          status: "OK",
          descriptionCn: "杩愯妯″紡",
          description: "Runtime mode",
          expectedType: "web | desktop",
        },
      ],
      errors: [],
      ok: true,
    };
    const table = formatValidationTable(result);
    expect(table).toContain("T3CODE_MODE");
    expect(table).toContain("OK");
    expect(table).toContain("Environment Variable Validation");
  });

  it("formats error table", () => {
    const result: ValidationResult = {
      entries: [
        {
          name: "T3CODE_MODE",
          required: false,
          value: "foo",
          status: "ERROR",
          descriptionCn: "杩愯妯″紡",
          description: "Runtime mode",
          expectedType: "web | desktop",
          errorDetail: 'Expected "web" or "desktop", actual "foo"',
        },
        {
          name: "T3CODE_PORT",
          required: false,
          value: "8080",
          status: "OK",
          descriptionCn: "鏈嶅姟鍣ㄧ鍙?,
          description: "Server port",
          expectedType: "number (1-65535)",
        },
      ],
      errors: [
        {
          name: "T3CODE_MODE",
          required: false,
          value: "foo",
          status: "ERROR",
          descriptionCn: "杩愯妯″紡",
          description: "Runtime mode",
          expectedType: "web | desktop",
          errorDetail: 'Expected "web" or "desktop", actual "foo"',
        },
      ],
      ok: false,
    };
    const table = formatValidationTable(result);
    expect(table).toContain("ERRORS FOUND");
    expect(table).toContain("1 error(s) found");
    expect(table).toContain("T3CODE_MODE");
  });

  it("marks T3CODE_HOME with star", () => {
    const result: ValidationResult = {
      entries: [
        {
          name: "T3CODE_HOME",
          required: false,
          value: "/home/user",
          status: "OK",
          descriptionCn: "鍏抽敭锛歍3 Code 鍩虹鐩綍",
          description: "CRITICAL: Base directory",
          expectedType: "string (path)",
        },
      ],
      errors: [],
      ok: true,
    };
    const table = formatValidationTable(result);
    expect(table).toContain("鈽?);
  });
});
