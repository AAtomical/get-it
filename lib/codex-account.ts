/**
 * Codex account + rate-limit introspection.
 *
 *   accountInfo(): decode the JWT id_token in ~/.codex/auth.json to
 *     pull email, name, plan type, organizations, subscription window —
 *     no network call, just a local file read + base64 decode.
 *
 *   rateLimits(): spawn `codex app-server` and call the JSON-RPC method
 *     `account/rateLimits/read` over stdio. This is the same code path
 *     the codex TUI uses to populate its status bar — confirmed by
 *     tracing the rpc.method field in ~/.codex/logs_2.sqlite. Returns
 *     primary (5-hour) and secondary (weekly) window usage + reset
 *     timestamps, plan type, and credit balance.
 *
 *   logout(): `codex logout` — removes ~/.codex/auth.json. Reversible
 *     by running codex login again.
 *
 * Robustness: every path swallows its own errors and returns `null` so
 * the UI can render a "no data" pill instead of crashing. Network is
 * never required for accountInfo(); rateLimits() needs an authenticated
 * Codex session and a working chatgpt.com connection.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";

// ── Binary path resolution (matches @openai/codex-sdk's findCodexPath) ──

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

function targetTriple(): string | null {
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

function resolveCodexBinary(): string | null {
  // Electron main exports this for us; respect it when it's there.
  if (process.env.CODEX_BINARY_PATH && fs.existsSync(process.env.CODEX_BINARY_PATH)) {
    return process.env.CODEX_BINARY_PATH;
  }
  const triple = targetTriple();
  const pkg = triple ? PLATFORM_PACKAGE_BY_TARGET[triple] : null;
  if (!triple || !pkg) return null;
  const exe = process.platform === "win32" ? "codex.exe" : "codex";

  // 1) Walk node_modules like the SDK does
  try {
    const moduleRequire = createRequire(import.meta.url);
    const codexPkgJson = moduleRequire.resolve("@openai/codex/package.json");
    const codexRequire = createRequire(codexPkgJson);
    const platformPkgJson = codexRequire.resolve(`${pkg}/package.json`);
    const vendorRoot = path.join(path.dirname(platformPkgJson), "vendor");
    const binaryPath = path.join(vendorRoot, triple, "codex", exe);
    if (fs.existsSync(binaryPath)) return binaryPath;
  } catch {
    /* try the next strategy */
  }

  // 2) Packaged Electron app: extraResources/codex-bin
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const staged = path.join(
      resourcesPath,
      "app.asar.unpacked",
      "electron",
      "codex-bin",
      triple,
      "codex",
      exe,
    );
    if (fs.existsSync(staged)) return staged;
  }

  // 3) Source-tree fallback: scripts/electron-prepare.mjs stages the
  //    binary at <repo>/electron/codex-bin/<triple>/codex/<exe>. Walk
  //    upward from cwd looking for it — covers `next dev`, the
  //    standalone server when launched from .next/standalone/, and
  //    plain `node` invocations from the repo root.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "electron", "codex-bin", triple, "codex", exe);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

// ── ~/.codex/auth.json → account info via JWT decode ────────────────────

const AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");

function base64UrlDecode(s: string): string {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64").toString("utf-8");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type CodexAccountInfo = {
  email: string | null;
  name: string | null;
  planType: string | null;
  organizations: Array<{ id: string; title: string; role: string }>;
  subscriptionActiveUntil: string | null;
  authMode: string | null;
};

export function readAccountInfo(): CodexAccountInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(AUTH_PATH, "utf-8");
  } catch {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const tokens = parsed.tokens as Record<string, unknown> | undefined;
  const idToken = tokens?.id_token as string | undefined;
  if (!idToken) return null;
  const claims = decodeJwtPayload(idToken);
  if (!claims) return null;
  const oai = claims["https://api.openai.com/auth"] as
    | Record<string, unknown>
    | undefined;
  const orgs = (oai?.organizations as unknown[] | undefined) ?? [];
  return {
    email: typeof claims.email === "string" ? claims.email : null,
    name: typeof claims.name === "string" ? claims.name : null,
    planType: typeof oai?.chatgpt_plan_type === "string" ? (oai.chatgpt_plan_type as string) : null,
    organizations: orgs
      .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
      .map((o) => ({
        id: String(o.id ?? ""),
        title: String(o.title ?? ""),
        role: String(o.role ?? ""),
      })),
    subscriptionActiveUntil:
      typeof oai?.chatgpt_subscription_active_until === "string"
        ? (oai.chatgpt_subscription_active_until as string)
        : null,
    authMode: typeof parsed.auth_mode === "string" ? (parsed.auth_mode as string) : null,
  };
}

// ── codex app-server JSON-RPC: account/rateLimits/read ──────────────────

export type CodexRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number | null;
};

export type CodexRateLimits = {
  planType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string;
  } | null;
  rateLimitReachedType: string | null;
};

function pickWindow(raw: unknown): CodexRateLimitWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const usedPercent =
    typeof w.usedPercent === "number"
      ? w.usedPercent
      : typeof w.used_percent === "number"
        ? w.used_percent
        : null;
  const windowDurationMins =
    typeof w.windowDurationMins === "number"
      ? w.windowDurationMins
      : typeof w.window_minutes === "number"
        ? w.window_minutes
        : null;
  const resetsAt =
    typeof w.resetsAt === "number"
      ? w.resetsAt
      : typeof w.resets_at === "number"
        ? w.resets_at
        : null;
  if (usedPercent == null || windowDurationMins == null) return null;
  return { usedPercent, windowDurationMins, resetsAt };
}

let _lastGoodRateLimits: CodexRateLimits | null = null;

/**
 * Read Codex rate-limit windows, with a process-local last-good cache.
 *
 * The underlying `codex app-server` JSON-RPC spawn is flaky by nature (a 5s
 * timeout, cold subprocess start, a busy machine). A transient null must not
 * blank the account panel — worse, it used to make an account engine fall back
 * to a token display, which reads like a silent provider switch. So once we
 * have read real windows we keep them and re-serve them whenever a fresh read
 * fails or comes back empty, until the next good read refreshes them.
 */
export async function readRateLimits(timeoutMs = 5000): Promise<CodexRateLimits | null> {
  const fresh = await readRateLimitsRaw(timeoutMs);
  if (fresh && (fresh.primary || fresh.secondary)) {
    _lastGoodRateLimits = fresh;
    return fresh;
  }
  return _lastGoodRateLimits ?? fresh;
}

async function readRateLimitsRaw(timeoutMs = 5000): Promise<CodexRateLimits | null> {
  const bin = resolveCodexBinary();
  if (!bin) return null;
  return new Promise((resolve) => {
    const child = spawn(bin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      // Don't inherit the env's ELECTRON_RUN_AS_NODE / Codex internals
      env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_sdk_ts" },
    });
    let settled = false;
    let stdoutBuf = "";
    const done = (value: CodexRateLimits | null) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);

    child.once("error", () => done(null));
    child.once("exit", () => done(null));

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf-8");
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2 && msg.result && typeof msg.result === "object") {
          const r = msg.result as Record<string, unknown>;
          const rl = r.rateLimits as Record<string, unknown> | undefined;
          if (!rl) {
            done({
              planType: null,
              primary: null,
              secondary: null,
              credits: null,
              rateLimitReachedType: null,
            });
            return;
          }
          done({
            planType: typeof rl.planType === "string" ? (rl.planType as string) : null,
            primary: pickWindow(rl.primary),
            secondary: pickWindow(rl.secondary),
            credits: rl.credits && typeof rl.credits === "object"
              ? {
                  hasCredits: !!(rl.credits as Record<string, unknown>).hasCredits,
                  unlimited: !!(rl.credits as Record<string, unknown>).unlimited,
                  balance: String((rl.credits as Record<string, unknown>).balance ?? "0"),
                }
              : null,
            rateLimitReachedType:
              typeof rl.rateLimitReachedType === "string"
                ? (rl.rateLimitReachedType as string)
                : null,
          });
          return;
        }
        // Handshake: send the rateLimits request right after initialize result
        if (msg.id === 1) {
          try {
            child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "initialized",
                params: {},
              }) + "\n",
            );
            child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "account/rateLimits/read",
                params: {},
              }) + "\n",
            );
          } catch {
            done(null);
          }
        }
      }
    });

    // Kick off: send `initialize`
    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "get-it", version: "1.0.0" },
          },
        }) + "\n",
      );
    } catch {
      done(null);
    }
  });
}

// ── Logout: `codex logout` removes ~/.codex/auth.json ───────────────────

export function runLogout(): boolean {
  const bin = resolveCodexBinary();
  if (!bin) return false;
  try {
    const r = spawnSync(bin, ["logout"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}
