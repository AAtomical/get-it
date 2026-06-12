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
import { whichBinary, augmentedPath } from "@/lib/providers/cli-runner";

export const runtime = "nodejs";

type ProviderStatus = {
  provider: ProviderName;
  label: string;
  docsUrl: string;
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  // Codex-specific fields (null for other providers)
  account: CodexAccountInfo | null;
  rateLimits: CodexRateLimits | null;
};

function checkCliAuth(binary: string, provider: ProviderName): boolean {
  if (provider === "claude") {
    // claude auth status — exit code 0 = logged in
    try {
      const isJs = binary.endsWith(".js");
      const bin = isJs ? process.execPath : binary;
      const args = isJs ? [binary, "auth", "status"] : ["auth", "status"];
      const r = spawnSync(bin, args, {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, PATH: augmentedPath() },
        shell: process.platform === "win32",
      });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  if (provider === "gemini") {
    const settings = loadSettings();
    if (settings.geminiApiKey) return true;
    try {
      const os = require("os");
      const path = require("path");
      const fs = require("fs");
      const credsPath = path.join(os.homedir(), ".gemini", "gemini-credentials.json");
      return fs.existsSync(credsPath);
    } catch {
      return false;
    }
  }

  return false;
}

function getCliVersion(binary: string): string | null {
  try {
    const isJs = binary.endsWith(".js");
    const bin = isJs ? process.execPath : binary;
    const args = isJs ? [binary, "--version"] : ["--version"];
    const r = spawnSync(bin, args, {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, PATH: augmentedPath() },
      shell: process.platform === "win32",
    });
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

  if (provider === "codex") {
    // Full Codex account info
    const account: CodexAccountInfo | null = (() => {
      try {
        return readAccountInfo();
      } catch {
        return null;
      }
    })();
    let limits: CodexRateLimits | null = null;
    try {
      limits = await readRateLimits();
    } catch {
      limits = null;
    }
    const status: ProviderStatus = {
      provider,
      label,
      docsUrl,
      installed: true, // if we got here, Codex SDK is available
      authenticated: !!account?.email,
      version: null,
      account,
      rateLimits: limits,
    };
    return NextResponse.json(status);
  }

  if (provider === "pi") {
    const status: ProviderStatus = {
      provider,
      label,
      docsUrl,
      installed: true,
      authenticated: !!settings.piUrl,
      version: null,
      account: !!settings.piUrl ? {
        email: "BYOK Connection",
        name: "Pi Backend",
        planType: "Proxy",
        organizations: [],
        subscriptionActiveUntil: null,
        authMode: "URL/Key",
      } : null,
      rateLimits: null,
    };
    return NextResponse.json(status);
  }

  // Gemini / Claude — stub status
  const binaryName = provider === "gemini" ? "gemini" : "claude";
  const binaryPath = whichBinary(binaryName);
  const installed = !!binaryPath;
  const authenticated = installed ? checkCliAuth(binaryPath, provider) : false;
  const version = installed ? getCliVersion(binaryPath) : null;

  const status: ProviderStatus = {
    provider,
    label,
    docsUrl,
    installed,
    authenticated,
    version,
    account: authenticated ? {
      email: provider === "gemini" ? "Google Account (via API Key)" : "Anthropic Account",
      name: provider === "gemini" ? "Gemini Developer" : "Claude Developer",
      planType: provider === "gemini" ? "API Access" : "Console / Pro",
      organizations: [],
      subscriptionActiveUntil: null,
      authMode: provider === "gemini" ? "API Key" : "CLI Auth",
    } : null,
    rateLimits: null,
  };
  return NextResponse.json(status);
}
