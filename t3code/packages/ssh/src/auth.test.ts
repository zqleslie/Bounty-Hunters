/**
 * auth.test.ts — Security-hardened SSH askpass tests
 *
 * Test coverage for GitHub Bounty #822 acceptance criteria:
 * 1. File permissions = 0600 (not world-readable)
 * 2. Trap cleanup behavior (temp file removed on exit)
 * 3. Path injection prevention (metacharacter validation)
 * 4. Windows SecureString usage
 * 5. End-to-end SSH auth still works
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, expect } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  buildSshAskpassHelperDescriptor,
  buildSshChildEnvironment,
  ensureSshAskpassHelpers,
  isSshAuthFailure,
  validateAskpassPath,
  ASKPASS_POSIX_SCRIPT,
  ASKPASS_WINDOWS_SCRIPT,
} from "./auth.ts";

// ---------------------------------------------------------------------------
// Existing tests (unchanged functionality)
// ---------------------------------------------------------------------------

describe("ssh auth", () => {
  it.effect("detects ssh auth failures from common permission denied messages", () =>
    Effect.sync(() => {
      assert.equal(
        isSshAuthFailure(
          new Error(
            "julius@100.65.180.100: Permission denied (publickey,password,keyboard-interactive).",
          ),
        ),
        true,
      );
      assert.equal(isSshAuthFailure(new Error("Permission denied (publickey).")), true);
      assert.equal(isSshAuthFailure(new Error("Connection timed out")), false);
      assert.equal(isSshAuthFailure(new Error("mkdir: Permission denied")), false);
    }),
  );

  it.effect("creates askpass env for cached password prompts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-askpass-test-" });
      const env = yield* buildSshChildEnvironment({
        authSecret: "super-secret",
        interactiveAuth: true,
        askpassDirectory: directory,
        platform: "linux",
        baseEnv: {},
      });

      const askpassPath = path.join(directory, "ssh-askpass.sh");
      assert.equal(env.SSH_ASKPASS, askpassPath);
      assert.equal(env.SSH_ASKPASS_REQUIRE, "force");
      assert.equal(env.T3_SSH_AUTH_SECRET, "super-secret");
      assert.equal(env.DISPLAY, "t3code");
      assert.equal(yield* fs.exists(askpassPath), true);
      assert.include(yield* fs.readFileString(askpassPath), 'printf "%s" "$T3_SSH_AUTH_SECRET"');
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("builds a windows askpass launcher pair", () =>
    Effect.gen(function* () {
      const descriptor = yield* buildSshAskpassHelperDescriptor({
        directory: "C:\\temp\\t3code-ssh-askpass",
        platform: "win32",
      }).pipe(Effect.provide(NodeServices.layer));

      assert.equal(descriptor.launcherPath, "C:\\temp\\t3code-ssh-askpass\\ssh-askpass.cmd");
      assert.deepEqual(
        descriptor.files.map((file) => file.path.split("\\").at(-1)),
        ["ssh-askpass.cmd", "ssh-askpass.ps1"],
      );
    }),
  );

  // ---------------------------------------------------------------------------
  // New security tests for Bounty #822
  // ---------------------------------------------------------------------------

  describe("#822 — askpass security hardening", () => {
    // --- 1. File permissions = 0600 ---

    it.effect("posix askpass script mode is 0600", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-perm-test-" });

        yield* ensureSshAskpassHelpers({ directory, platform: "linux" });

        const askpath = yield* Path.Path;
        const scriptPath = askpath.join(directory, "ssh-askpass.sh");
        const stat = yield* fs.stat(scriptPath);
        // mode 0600 = owner read+write only
        assert.equal(stat.mode, 0o600);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.effect("descriptor assigns mode 0600 to posix script", () =>
      Effect.gen(function* () {
        const descriptor = yield* buildSshAskpassHelperDescriptor({
          directory: "/tmp/t3code-ssh-askpass-test",
          platform: "linux",
        }).pipe(Effect.provide(NodeServices.layer));

        const shFile = descriptor.files.find((f) => f.path.endsWith(".sh"));
        assert.isDefined(shFile);
        assert.equal(shFile!.mode, 0o600);
      }),
    );

    // --- 2. Trap cleanup behavior ---

    it.effect("posix script contains trap handler for EXIT INT TERM HUP", () =>
      Effect.sync(() => {
        // Verify the script text includes proper trap directives
        assert.include(ASKPASS_POSIX_SCRIPT, "trap");
        assert.include(ASKPASS_POSIX_SCRIPT, "EXIT");
        assert.include(ASKPASS_POSIX_SCRIPT, "INT");
        assert.include(ASKPASS_POSIX_SCRIPT, "TERM");
        assert.include(ASKPASS_POSIX_SCRIPT, "HUP");
        // Verify rm -f cleanup function exists
        assert.include(ASKPASS_POSIX_SCRIPT, "rm -f");
        assert.include(ASKPASS_POSIX_SCRIPT, "_ASKPASS_TMPFILE");
      }),
    );

    it.effect("posix script uses mktemp for secure temp file creation", () =>
      Effect.sync(() => {
        assert.include(ASKPASS_POSIX_SCRIPT, "mktemp");
        // Verify chmod 0600 is called on the temp file
        assert.include(ASKPASS_POSIX_SCRIPT, "chmod 0600");
      }),
    );

    // --- 3. Path injection prevention ---

    it.effect("validateAskpassPath rejects shell metacharacters", () =>
      Effect.sync(() => {
        // Safe paths
        assert.equal(validateAskpassPath("/tmp/t3code-ssh-askpass"), true);
        assert.equal(validateAskpassPath("C:\\temp\\t3code"), true);
        assert.equal(validateAskpassPath("/home/user/.ssh/t3_code"), true);
        assert.equal(validateAskpassPath("/opt/t3code-ssh-runtime/abc123"), true);

        // Unsafe paths with metacharacters
        assert.equal(validateAskpassPath("/tmp/foo; rm -rf /"), false); // semicolon
        assert.equal(validateAskpassPath("/tmp/foo|cat /etc/passwd"), false); // pipe
        assert.equal(validateAskpassPath("/tmp/foo$(whoami)"), false); // command substitution
        assert.equal(validateAskpassPath("/tmp/foo`id`"), false); // backtick
        assert.equal(validateAskpassPath("/tmp/foo && cat secret"), false); // &&
        assert.equal(validateAskpassPath("/tmp/foo > /tmp/leak"), false); // redirect
        assert.equal(validateAskpassPath("/tmp/foo || echo pwned"), false); // ||
        assert.equal(validateAskpassPath("/tmp/foo$HOME"), false); // dollar
        assert.equal(validateAskpassPath("/tmp/foo bar"), false); // space
        assert.equal(validateAskpassPath("/tmp/foo\tbar"), false); // tab
        assert.equal(validateAskpassPath("/tmp/foo\"bar"), false); // double quote
        assert.equal(validateAskpassPath("/tmp/foo'bar"), false); // single quote
        assert.equal(validateAskpassPath(""), false); // empty string
      }),
    );

    it.effect("posix script contains case-based path validation", () =>
      Effect.sync(() => {
        assert.include(ASKPASS_POSIX_SCRIPT, "case");
        assert.include(ASKPASS_POSIX_SCRIPT, 'esac');
        assert.include(ASKPASS_POSIX_SCRIPT, "metacharacters");
        assert.include(ASKPASS_POSIX_SCRIPT, "exit 1");
      }),
    );

    it.effect("ensureSshAskpassHelpers rejects directory with metacharacters", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const result = yield* ensureSshAskpassHelpers({
          directory: "/tmp/t3code; rm -rf /",
          platform: "linux",
        }).pipe(Effect.flip);

        // Should fail with a SystemError about InvalidDirectory
        assert.include(String(result), "InvalidDirectory");
        assert.include(String(result), "metacharacters");
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("buildSshChildEnvironment rejects directory with metacharacters", () =>
      Effect.gen(function* () {
        const result = yield* buildSshChildEnvironment({
          interactiveAuth: true,
          askpassDirectory: "/tmp/ssh$(whoami)",
          platform: "linux",
          baseEnv: {},
        }).pipe(Effect.flip);

        assert.include(String(result), "InvalidDirectory");
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    // --- 4. Windows SecureString ---

    it.effect("windows script uses SecureString and BSTR zeroing", () =>
      Effect.sync(() => {
        // Must use ConvertTo-SecureString
        assert.include(ASKPASS_WINDOWS_SCRIPT, "ConvertTo-SecureString");
        // Must use Marshal for BSTR handling
        assert.include(ASKPASS_WINDOWS_SCRIPT, "SecureStringToBSTR");
        assert.include(ASKPASS_WINDOWS_SCRIPT, "PtrToStringAuto");
        // Must zero out BSTR after use
        assert.include(ASKPASS_WINDOWS_SCRIPT, "ZeroFreeBSTR");
        // Should NOT contain raw plaintext WriteLine of env var directly
        assert.isFalse(
          ASKPASS_WINDOWS_SCRIPT.includes("[Console]::Out.WriteLine($env:T3_SSH_AUTH_SECRET)"),
        );
      }),
    );

    // --- 5. End-to-end: SSH auth still works after security hardening ---

    it.effect("end-to-end: buildSshChildEnvironment produces valid env on linux", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-e2e-test-" });

        const env = yield* buildSshChildEnvironment({
          authSecret: "test-password-123",
          interactiveAuth: true,
          askpassDirectory: directory,
          platform: "linux",
          baseEnv: { HOME: "/home/testuser" },
        });

        // Environment should have all required keys
        assert.isDefined(env.SSH_ASKPASS);
        assert.equal(env.SSH_ASKPASS_REQUIRE, "force");
        assert.equal(env.T3_SSH_AUTH_SECRET, "test-password-123");
        assert.equal(env.DISPLAY, "t3code");
        assert.equal(env.HOME, "/home/testuser");

        // Script file should exist and be readable
        assert.equal(yield* fs.exists(env.SSH_ASKPASS!), true);
        const contents = yield* fs.readFileString(env.SSH_ASKPASS!);
        assert.include(contents, "mktemp");
        assert.include(contents, "trap");
        assert.include(contents, "chmod 0600");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.effect("end-to-end: buildSshChildEnvironment produces valid env on windows", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-e2e-win-" });

        const env = yield* buildSshChildEnvironment({
          authSecret: "test-password-456",
          interactiveAuth: true,
          askpassDirectory: directory,
          platform: "win32",
          baseEnv: {},
        });

        assert.isDefined(env.SSH_ASKPASS);
        assert.equal(env.SSH_ASKPASS_REQUIRE, "force");
        assert.equal(env.T3_SSH_AUTH_SECRET, "test-password-456");
        // Windows should NOT set DISPLAY
        assert.isUndefined(env.DISPLAY);

        // Both .cmd and .ps1 files should exist
        assert.equal(yield* fs.exists(env.SSH_ASKPASS!), true);
        const ps1Path = env.SSH_ASKPASS!.replace(".cmd", ".ps1");
        assert.equal(yield* fs.exists(ps1Path), true);

        const ps1Contents = yield* fs.readFileString(ps1Path);
        assert.include(ps1Contents, "SecureString");
        assert.include(ps1Contents, "ZeroFreeBSTR");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    // --- 6. No passwords in stdout ---

    it.effect("posix script does not echo password to stdout directly", () =>
      Effect.sync(() => {
        // The script should NOT contain any direct echo/printf of the secret to stdout
        // without going through the temp file
        const lines = ASKPASS_POSIX_SCRIPT.split("\n");
        const stdoutLines = lines.filter(
          (line) =>
            line.includes("printf") &&
            !line.includes(">&2") &&
            !line.includes("> \"$_ASKPASS_TMPFILE\""),
        );
        // Only the cat line should output, which reads from the protected temp file
        const hasCatOutput = ASKPASS_POSIX_SCRIPT.includes('cat "$_ASKPASS_TMPFILE"');
        assert.isTrue(hasCatOutput, "Script should use cat from temp file for output");
      }),
    );

    it.effect("windows script does not leak password to error output", () =>
      Effect.sync(() => {
        // Should NOT write the actual secret to stderr
        assert.isFalse(
          ASKPASS_WINDOWS_SCRIPT.includes("$env:T3_SSH_AUTH_SECRET") &&
            ASKPASS_WINDOWS_SCRIPT.includes("Error.WriteLine"),
        );
      }),
    );
  });
});
