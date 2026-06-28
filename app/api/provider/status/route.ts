/**
 * GET /api/provider/status
 *
 * Returns the active provider's status snapshot for the account panel.
 *
 * For Codex: delegates to the existing readAccountInfo() + readRateLimits().
 * For Gemini/Claude: checks binary presence and auth status (stub panels).
 */

import { NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import { loadSettings } from "@/lib/settings-store";
import { PROVIDER_LABELS, PROVIDER_DOCS } from "@/lib/provider-types";
import type { ProviderName } from "@/lib/provider-types";
import {
  readAccountInfo,
  readRateLimits,
  type CodexAccountInfo,
  type CodexRateLimits,
} from "@/lib/codex-account";
import { whichBinary, augmentedPath, resolveBundledBinary } from "@/lib/providers/cli-runner";
import { readUsage, type ProviderUsage } from "@/lib/usage-store";

export const runtime = "nodejs";

type ProviderStatus = {
  provider: ProviderName;
  label: string;
  docsUrl: string;
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  /** "account" → show plan/limits; "apiKey" → show token usage. */
  authMode: "account" | "apiKey" | null;
  // Codex-specific fields (null for other providers)
  account: CodexAccountInfo | null;
  rateLimits: CodexRateLimits | null;
  /** Cumulative token usage (shown for apiKey providers; informational for account). */
  usage: ProviderUsage | null;
};

/**
 * Spawn a bundled or PATH CLI. `.js` bundles (Gemini) run through Electron's
 * own node via process.execPath + ELECTRON_RUN_AS_NODE=1; native binaries
 * (Claude) run directly.
 */
function spawnCli(binary: string, args: string[]) {
  const isJs = binary.endsWith(".js");
  const bin = isJs ? process.execPath : binary;
  const finalArgs = isJs ? [binary, ...args] : args;
  return spawnSync(bin, finalArgs, {
    encoding: "utf8",
    timeout: 6000,
    env: {
      ...process.env,
      PATH: augmentedPath(),
      ...(isJs ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
    shell: false,
  });
}

type ClaudeAuthStatus = {
  loggedIn: boolean;
  email: string | null;
  authMethod: string | null;
  subscriptionType: string | null;
};

/** Read `claude auth status` output (the CLI emits JSON). */
function readClaudeAuthStatus(binary: string): ClaudeAuthStatus {
  try {
    const r = spawnCli(binary, ["auth", "status"]);
    const out = (r.stdout || "").trim();
    const j = JSON.parse(out) as {
      loggedIn?: boolean;
      email?: string;
      authMethod?: string;
      subscriptionType?: string;
    };
    return {
      loggedIn: !!j.loggedIn,
      email: j.email ?? null,
      authMethod: j.authMethod ?? null,
      subscriptionType: j.subscriptionType ?? null,
    };
  } catch {
    return { loggedIn: false, email: null, authMethod: null, subscriptionType: null };
  }
}

function getCliVersion(binary: string): string | null {
  try {
    const r = spawnCli(binary, ["--version"]);
    if (r.status !== 0) return null;
    const out = (r.stdout || "").trim();
    // Extract version number from output
    const m = /(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)/i.exec(out);
    return m ? m[1] : out.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

export async function GET() {
  const settings = loadSettings();
  const provider = settings.provider;
  const label = PROVIDER_LABELS[provider];
  const docsUrl = PROVIDER_DOCS[provider];

  const usage = readUsage(provider);

  if (provider === "codex") {
    const account: CodexAccountInfo | null = (() => {
      try {
        return readAccountInfo();
      } catch {
        return null;
      }
    })();
    // Codex on an API key (auth_mode !== "chatgpt") has no readable limits →
    // show token usage instead; ChatGPT login shows subscription limits.
    const isApiKey = !!account && account.authMode != null && account.authMode !== "chatgpt";
    let limits: CodexRateLimits | null = null;
    if (!isApiKey) {
      try {
        limits = await readRateLimits();
      } catch {
        limits = null;
      }
    }
    const status: ProviderStatus = {
      provider,
      label,
      docsUrl,
      installed: true,
      authenticated: !!account?.email,
      version: null,
      authMode: isApiKey ? "apiKey" : "account",
      account,
      rateLimits: limits,
      usage,
    };
    return NextResponse.json(status);
  }

  if (provider === "pi") {
    // A real BYOK config: an endpoint, plus a key for any remote provider
    // (Ollama runs locally and needs none). Avoids showing "connected" just
    // because the default localhost URL is present.
    const configured =
      !!settings.piUrl && (settings.piProvider === "ollama" || !!settings.piApiKey);
    const status: ProviderStatus = {
      provider,
      label,
      docsUrl,
      installed: true,
      authenticated: configured,
      version: null,
      authMode: "apiKey",
      account: configured
        ? {
            email: settings.piUrl ?? null,
            name: "Your own key (BYOK)",
            planType: settings.piProvider ?? "Custom",
            organizations: [],
            subscriptionActiveUntil: null,
            authMode: "BYOK",
          }
        : null,
      rateLimits: null,
      usage,
    };
    return NextResponse.json(status);
  }

  // Gemini / Claude — resolve the BUNDLED CLI first (not on $PATH when packaged),
  // falling back to a PATH lookup for source-tree dev.
  const binaryPath =
    resolveBundledBinary(provider as "gemini" | "claude") ??
    whichBinary(provider === "gemini" ? "gemini" : "claude");
  const installed = !!binaryPath;
  const version = installed && binaryPath ? getCliVersion(binaryPath) : null;

  let authenticated = false;
  let account: ProviderStatus["account"] = null;
  let authMode: ProviderStatus["authMode"] = null;

  if (provider === "claude" && binaryPath) {
    // Rich, accurate status straight from `claude auth status` JSON.
    const auth = readClaudeAuthStatus(binaryPath);
    authenticated = auth.loggedIn;
    // firstParty = claude.ai subscription; anything else = Console/API key.
    authMode = auth.authMethod === "claude.ai" ? "account" : "apiKey";
    if (auth.loggedIn) {
      account = {
        email: auth.email,
        name: auth.email ?? "Claude account",
        // Show the real plan (max / pro / team), like Codex shows plus/pro.
        planType:
          authMode === "account"
            ? auth.subscriptionType ?? "Subscription"
            : "API (Console)",
        organizations: [],
        subscriptionActiveUntil: null,
        authMode: auth.authMethod,
      };
    }
  } else if (provider === "gemini") {
    // Gemini is API-key only — Google retired the free-tier browser login.
    authMode = "apiKey";
    authenticated = !!settings.geminiApiKey;
    if (authenticated) {
      account = {
        email: "Gemini (API key)",
        name: "Gemini",
        planType: "API key",
        organizations: [],
        subscriptionActiveUntil: null,
        authMode: "API Key",
      };
    }
  }

  const status: ProviderStatus = {
    provider,
    label,
    docsUrl,
    installed,
    authenticated,
    version,
    authMode,
    account,
    rateLimits: null,
    usage,
  };
  return NextResponse.json(status);
}
