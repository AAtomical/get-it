/**
 * Shared subprocess runner for CLI-based AI providers (Gemini, Claude).
 *
 * Spawns a child process, feeds it a prompt, captures structured JSON
 * output, and handles timeouts + error classification. Both
 * gemini-provider.ts and claude-provider.ts build on this.
 */

import { execFile, spawnSync, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import fs from "node:fs";
import path from "node:path";

export type CliRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

/**
 * Locate a binary on $PATH. Returns the absolute path or null.
 * Uses `which` on macOS/Linux, `where.exe` on Windows.
 */
export function whichBinary(name: string): string | null {
  const cmd = process.platform === "win32" ? "where.exe" : "which";
  try {
    const r = spawnSync(cmd, [name], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
      // Ensure we can find binaries installed via npm -g on macOS.
      // Terminal shells populate PATH via profile, but Electron apps
      // inherit a minimal PATH. Merge common install dirs.
      env: {
        ...process.env,
        PATH: augmentedPath(),
      },
    });
    if (r.status !== 0) return null;
    const line = (r.stdout || "").trim().split(/\r?\n/)[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}

/**
 * PATH augmented with common global npm / Homebrew binary locations.
 * Electron apps on macOS often get a bare-bones PATH that doesn't
 * include /usr/local/bin, ~/.npm-global/bin, or nvm shims.
 */
function augmentedPath(): string {
  const base = process.env.PATH || "";
  const extras: string[] = [];
  const home = process.env.HOME || "";
  if (process.platform !== "win32") {
    extras.push(
      "/usr/local/bin",
      "/opt/homebrew/bin",
      `${home}/.npm-global/bin`,
      `${home}/.nvm/current/bin`,
      `${home}/.local/bin`,
    );
  }
  const existing = new Set(base.split(":"));
  const additions = extras.filter((p) => !existing.has(p));
  return additions.length ? `${base}:${additions.join(":")}` : base;
}

export { augmentedPath };

export function getTargetTriple(): string | null {
  const { platform, arch } = process;
  if (platform === "linux" || platform === "android") {
    if (arch === "x64") return "x86_64-unknown-linux-musl";
    if (arch === "arm64") return "aarch64-unknown-linux-musl";
  } else if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
  } else if (platform === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
  }
  return null;
}

export function resolveBundledBinary(provider: "claude" | "gemini"): string | null {
  if (provider === "claude" && process.env.CLAUDE_BINARY_PATH && fs.existsSync(process.env.CLAUDE_BINARY_PATH)) {
    return process.env.CLAUDE_BINARY_PATH;
  }
  if (provider === "gemini" && process.env.GEMINI_BINARY_PATH && fs.existsSync(process.env.GEMINI_BINARY_PATH)) {
    return process.env.GEMINI_BINARY_PATH;
  }

  const triple = getTargetTriple();
  const isWin = process.platform === "win32";

  const getSubPath = () => {
    if (provider === "claude") {
      return triple ? ["claude-bin", triple, "claude", isWin ? "claude.exe" : "claude"] : null;
    }
    return ["gemini-bin", "gemini-cli", "bundle", "gemini.js"];
  };

  const subPath = getSubPath();
  if (!subPath) return null;

  // 1) Packaged Electron app: extraResources
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const staged = path.join(resourcesPath, "app.asar.unpacked", "electron", ...subPath);
    if (fs.existsSync(staged)) return staged;
    const staged2 = path.join(resourcesPath, "electron", ...subPath);
    if (fs.existsSync(staged2)) return staged2;
  }

  // 2) Source-tree fallback: scripts/electron-prepare.mjs stages
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "electron", ...subPath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * Run a CLI binary with the given arguments and return structured output.
 *
 * - Accepts an optional AbortSignal for cancellation.
 * - Has a generous 120-second default timeout (LLM calls can be slow).
 * - Returns stderr and exit code for error classification.
 */
export async function runCliBinary(
  binPath: string,
  args: string[],
  opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: string;
  },
): Promise<CliRunResult> {
  const timeout = opts?.timeoutMs ?? 120_000;
  try {
    let finalBinPath = binPath;
    const finalArgs = [...args];
    if (binPath.endsWith(".js")) {
      finalArgs.unshift(binPath);
      finalBinPath = process.execPath;
    }

    const execOptions: ExecFileOptionsWithStringEncoding = {
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10 MB — model responses can be large
      encoding: "utf8",
      cwd: opts?.cwd,
      signal: opts?.signal,
      env: {
        ...process.env,
        PATH: augmentedPath(),
        GEMINI_CLI_TRUST_WORKSPACE: "true",
        ELECTRON_RUN_AS_NODE: binPath.endsWith(".js") ? "1" : process.env.ELECTRON_RUN_AS_NODE,
        ...(opts?.env || {}),
      },
      // @ts-ignore: 'detached' is missing in some version of node types for ExecFileOptions
      detached: process.platform !== "win32",
    };

    const p = execFileAsync(finalBinPath, finalArgs, execOptions);

    // Close stdin immediately after writing (if provided) so Claude doesn't wait
    if (p.child && p.child.stdin) {
      if (opts?.stdin) {
        p.child.stdin.write(opts.stdin);
      }
      p.child.stdin.end();
    }

    if (opts?.signal) {
      const onAbort = () => {
        if (p.child && typeof p.child.pid === "number") {
          try {
            if (process.platform === "win32") {
              const { spawnSync } = require("child_process");
              spawnSync("taskkill", ["/pid", String(p.child.pid), "/f", "/t"], { stdio: "ignore", windowsHide: true });
            } else {
              process.kill(-p.child.pid, "SIGKILL");
            }
          } catch {}
        }
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
      p.finally(() => opts.signal?.removeEventListener("abort", onAbort)).catch(() => {});
    }

    const { stdout, stderr } = await p;
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };
    // execFile rejects on non-zero exit but still provides stdout/stderr
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode:
        typeof e.code === "number"
          ? e.code
          : e.killed || e.signal === "SIGTERM"
            ? -1
            : 1,
    };
  }
}

/** Re-escape lone backslashes the model left as invalid JSON escape
 *  sequences (e.g. a literal "\ " inside a long code string), while leaving
 *  genuine escapes (\\, \", \n, \uXXXX, …) untouched. */
function repairInvalidEscapes(text: string): string {
  return text.replace(
    /\\(["\\/bfnrtu]|u[0-9a-fA-F]{4})|\\([\s\S])/g,
    (_m, valid: string | undefined, bad: string | undefined) =>
      valid !== undefined ? "\\" + valid : "\\\\" + bad,
  );
}

/** Best-effort completion of JSON that was truncated mid-output (the model
 *  hit its token limit while emitting a long string value): close a dangling
 *  string and any still-open objects/arrays so the partial object can parse.
 *  Returns null when the text is not actually truncated. */
function closeTruncatedJson(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }
  if (!inString && stack.length === 0) return null;
  let out = escaped ? text.slice(0, -1) : text;
  if (inString) out += '"';
  for (let i = stack.length - 1; i >= 0; i--) {
    out += stack[i] === "{" ? "}" : "]";
  }
  return out;
}

/** Strip markdown code fences the model sometimes wraps JSON in, then parse. */
export function parseJsonResponse<T>(raw: string): T {
  let text = raw.trim();
  if (!text) throw new Error("Empty response from CLI");

  // Attempt to strip standard markdown fences just in case
  text = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const candidates = [text];
  // If exact parsing fails (e.g. because of CLI warnings on stdout), also try
  // the outermost {...} slice.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.substring(firstBrace, lastBrace + 1));
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    // Try the raw candidate first, then a copy with invalid escapes repaired
    // (gemini-3.5-flash sometimes emits stray backslashes in long code strings),
    // then a copy completed if the output was truncated mid-string.
    const repaired = repairInvalidEscapes(candidate);
    const variants = [candidate, repaired];
    const completed = closeTruncatedJson(repaired);
    if (completed) variants.push(completed);
    for (const variant of variants) {
      try {
        return JSON.parse(variant) as T;
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw new Error(
    `Failed to parse JSON response: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
