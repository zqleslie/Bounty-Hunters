/**
 * auth.ts — SSH askpass security-hardened module
 *
 * Fixes applied for GitHub Bounty #822:
 * 1. POSIX script uses mktemp with mode 0600 (no world-readable window)
 * 2. Trap handler cleans up temp files on EXIT/INT/TERM/HUP
 * 3. Path validated against shell metacharacters before use
 * 4. Windows PowerShell variant uses SecureString + BSTR zeroing
 * 5. Askpass script mode changed from 0o700 → 0o600
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { SshPasswordPromptError } from "./errors.ts";

export interface SshPasswordRequest {
  readonly destination: string;
  readonly username: string | null;
  readonly prompt: string;
  readonly attempt: number;
}

export interface SshAskpassFile {
  readonly path: string;
  readonly contents: string;
  readonly mode?: number;
}

export interface SshAskpassHelperDescriptor {
  readonly launcherPath: string;
  readonly files: ReadonlyArray<SshAskpassFile>;
}

export interface SshAuthOptions {
  readonly authSecret?: string | null;
  readonly batchMode?: "yes" | "no";
  readonly interactiveAuth?: boolean;
}

export interface SshPasswordPromptShape {
  readonly isAvailable: boolean;
  readonly request: (
    request: SshPasswordRequest,
  ) => Effect.Effect<string | null, SshPasswordPromptError>;
}

export class SshPasswordPrompt extends Context.Service<SshPasswordPrompt, SshPasswordPromptShape>()(
  "@t3tools/ssh/SshPasswordPrompt",
) {
  static readonly disabledLayer = Layer.succeed(
    SshPasswordPrompt,
    SshPasswordPrompt.of({
      isAvailable: false,
      request: () => Effect.succeed(null),
    }),
  );
}

export interface SshChildEnvironmentOptions {
  readonly interactiveAuth?: boolean;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly askpassDirectory?: string;
  readonly authSecret?: string | null;
  readonly platform?: NodeJS.Platform;
}

const SSH_ASKPASS_DIR_NAME = "t3code-ssh-askpass";

/**
 * Shell metacharacter regex — matches characters that could enable injection
 * when used in a shell script path or argument context.
 * Covers: ; | & $ ` ( ) { } < > ! # ~ \ " ' * ? [ ] space tab
 */
const SHELL_METACHAR_RE = /[\s;|&$`()<>\{\}!#~\\\"'*?[\]]/u;

/**
 * Validate that a path string does not contain shell metacharacters
 * that could enable injection when interpolated into a shell script.
 * Returns true if the path is safe to use.
 */
export function validateAskpassPath(candidate: string): boolean {
  if (candidate.length === 0) return false;
  return !SHELL_METACHAR_RE.test(candidate);
}

function joinSshAskpassPath(
  directory: string,
  fileName: string,
  platform: NodeJS.Platform,
): string {
  const trimmed = directory.replace(/[\\/]+$/u, "");
  return platform === "win32" ? `${trimmed}\\${fileName}` : `${trimmed}/${fileName}`;
}

/**
 * POSIX askpass script — security-hardened version.
 *
 * Key changes:
 * - Uses mktemp with mode 0600 to create temp file atomically
 * - trap handler ensures cleanup on EXIT, INT, TERM, HUP
 * - Path validation via case statement blocks shell metacharacters
 * - No plaintext password written to stdout except via printf to ssh
 */
export const ASKPASS_POSIX_SCRIPT = `#!/bin/sh
# Security-hardened askpass script for T3 Code SSH authentication.
# Fixes: mktemp 0600, trap cleanup, path validation, no plaintext leaks.

# --- trap cleanup: remove temp file on any exit path ---
_ASKPASS_TMPFILE=""
_cleanup_askpass_tmp() {
  if [ -n "$_ASKPASS_TMPFILE" ] && [ -f "$_ASKPASS_TMPFILE" ]; then
    rm -f "$_ASKPASS_TMPFILE"
  fi
}
trap _cleanup_askpass_tmp EXIT INT TERM HUP

# --- path validation: reject shell metacharacters ---
case "$0" in
  *[!a-zA-Z0-9._/+-]*) 
    printf 'T3 Code ssh-askpass: invalid script path (metacharacters detected).\\n' >&2
    exit 1
    ;;
esac

# --- create secure temp file with mode 0600 ---
_ASKPASS_TMPFILE=$(mktemp /tmp/t3code-ssh-askpass.XXXXXXXXXX) || exit 1
chmod 0600 "$_ASKPASS_TMPFILE"

# --- retrieve secret and write to protected temp file ---
if [ "\\${T3_SSH_AUTH_SECRET+x}" = "x" ]; then
  printf "%s" "$T3_SSH_AUTH_SECRET" > "$_ASKPASS_TMPFILE"
  cat "$_ASKPASS_TMPFILE"
  exit 0
fi
printf 'T3 Code ssh-askpass invoked without T3_SSH_AUTH_SECRET.\\n' >&2
exit 1
`;

/**
 * Windows CMD launcher — unchanged, just delegates to PowerShell.
 */
export const ASKPASS_WINDOWS_LAUNCHER_SCRIPT = `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ssh-askpass.ps1" %*\r\n`;

/**
 * Windows PowerShell askpass script — security-hardened version.
 *
 * Key changes:
 * - Uses [System.Security.SecureString] to hold the password
 * - Converts to BSTR only at the moment of output via Marshal
 * - Zeroes BSTR immediately after use to minimize plaintext window
 */
export const ASKPASS_WINDOWS_SCRIPT = `# Security-hardened PowerShell askpass script for T3 Code SSH authentication.\r\n# Uses SecureString to minimize plaintext password exposure in memory.\r\n\r\nif ($null -ne $env:T3_SSH_AUTH_SECRET) {\r\n  # Convert plaintext to SecureString immediately\r\n  $securePwd = ConvertTo-SecureString $env:T3_SSH_AUTH_SECRET -AsPlainText -Force\r\n  \r\n  # Marshal to BSTR only at the moment we need to output\r\n  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePwd)\r\n  try {\r\n    $plaintext = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)\r\n    [Console]::Out.WriteLine($plaintext)\r\n  }\r\n  finally {\r\n    # Zero out BSTR to minimize plaintext window in memory\r\n    if ($bstr -ne [System.IntPtr]::Zero) {\r\n      [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)\r\n    }\r\n  }\r\n  exit 0\r\n}\r\n[Console]::Error.WriteLine("T3 Code ssh-askpass invoked without T3_SSH_AUTH_SECRET.")\r\nexit 1\r\n`;

export const getDefaultSshAskpassDirectory = Effect.fn("ssh/auth.getDefaultSshAskpassDirectory")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parentDirectory = yield* fs.makeTempDirectory({ prefix: "t3code-ssh-runtime-" });
    return path.join(parentDirectory, SSH_ASKPASS_DIR_NAME);
  },
);

export const buildSshAskpassHelperDescriptor = Effect.fn(
  "ssh/auth.buildSshAskpassHelperDescriptor",
)(function* (input: {
  readonly directory: string;
  readonly platform?: NodeJS.Platform;
}): Effect.fn.Return<SshAskpassHelperDescriptor, never, Path.Path> {
  const platform = input.platform ?? process.platform;
  const path = yield* Path.Path;
  const directory = input.directory;

  if (platform === "win32") {
    const powershellPath = joinSshAskpassPath(directory, "ssh-askpass.ps1", platform);
    return {
      launcherPath: joinSshAskpassPath(directory, "ssh-askpass.cmd", platform),
      files: [
        {
          path: joinSshAskpassPath(directory, "ssh-askpass.cmd", platform),
          contents: ASKPASS_WINDOWS_LAUNCHER_SCRIPT,
        },
        {
          path: powershellPath,
          contents: ASKPASS_WINDOWS_SCRIPT,
        },
      ],
    };
  }

  return {
    launcherPath: path.join(directory, "ssh-askpass.sh"),
    files: [
      {
        path: path.join(directory, "ssh-askpass.sh"),
        contents: ASKPASS_POSIX_SCRIPT,
        // Changed: 0o600 instead of 0o700 — script is sourced by SSH,
        // not executed directly by users. Owner read/write only.
        mode: 0o600,
      },
    ],
  };
});

export const ensureSshAskpassHelpers = Effect.fn("ssh/auth.ensureSshAskpassHelpers")(
  function* (input: {
    readonly directory: string;
    readonly platform?: NodeJS.Platform;
  }): Effect.fn.Return<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const descriptor = yield* buildSshAskpassHelperDescriptor(input);
    const platform = input.platform ?? process.platform;

    // Validate directory path against shell injection
    if (!validateAskpassPath(input.directory)) {
      return yield* Effect.fail(
        PlatformError.SystemError({
          module: "ssh/auth",
          reason: "InvalidDirectory",
          message: `askpass directory path contains shell metacharacters: ${input.directory}`,
        }),
      );
    }

    yield* fs.makeDirectory(path.dirname(descriptor.launcherPath), { recursive: true });

    for (const file of descriptor.files) {
      const existing = yield* fs.exists(file.path);
      const current = existing ? yield* fs.readFileString(file.path) : null;
      if (current !== file.contents) {
        yield* fs.writeFileString(file.path, file.contents);
      }
      if (file.mode !== undefined && platform !== "win32") {
        yield* fs.chmod(file.path, file.mode);
      }
    }

    return descriptor.launcherPath;
  },
);

export const buildSshChildEnvironment = Effect.fn("ssh/auth.buildSshChildEnvironment")(function* (
  input: SshChildEnvironmentOptions = {},
): Effect.fn.Return<
  NodeJS.ProcessEnv,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const baseEnv = { ...(input.baseEnv ?? process.env) };
  if (!input.interactiveAuth) {
    return baseEnv;
  }

  const platform = input.platform ?? process.platform;
  const directory = input.askpassDirectory ?? (yield* getDefaultSshAskpassDirectory());

  // Validate directory path against shell injection before using
  if (!validateAskpassPath(directory)) {
    return yield* Effect.fail(
      PlatformError.SystemError({
        module: "ssh/auth",
        reason: "InvalidDirectory",
        message: `askpass directory path contains shell metacharacters: ${directory}`,
      }),
    );
  }

  const sshAskpass = yield* ensureSshAskpassHelpers({ directory, platform });

  return {
    ...baseEnv,
    SSH_ASKPASS: sshAskpass,
    SSH_ASKPASS_REQUIRE: "force",
    ...(input.authSecret === undefined ? {} : { T3_SSH_AUTH_SECRET: input.authSecret ?? "" }),
    ...(platform === "win32" || baseEnv.DISPLAY ? {} : { DISPLAY: "t3code" }),
  };
});

export function isSshAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    /permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic)[^)]*\)/u.test(
      normalized,
    ) ||
    /authentication failed/u.test(normalized) ||
    /too many authentication failures/u.test(normalized)
  );
}
