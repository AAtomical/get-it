/**
 * POST /api/provider/logout  body: { provider?: ProviderName }
 *
 * Provider-agnostic sign-out / disconnect:
 *   codex  → `codex logout` (clears ~/.codex/auth.json)
 *   claude → `claude auth logout`
 *   gemini → clear the saved API key (Gemini is API-key only)
 *   pi     → clear the saved BYOK endpoint + key
 * Also resets that provider's cumulative token usage. Returns { ok }.
 */

import { NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import { runLogout } from "@/lib/codex-account";
import { loadSettings, saveSettings } from "@/lib/settings-store";
import { resolveBundledBinary, augmentedPath } from "@/lib/providers/cli-runner";
import { resetUsage } from "@/lib/usage-store";
import type { ProviderName } from "@/lib/provider-types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let provider: ProviderName = loadSettings().provider;
  try {
    const b = (await req.json()) as { provider?: ProviderName };
    if (b && typeof b.provider === "string") provider = b.provider;
  } catch {
    /* fall back to the active provider */
  }

  let ok = false;
  if (provider === "codex") {
    ok = runLogout();
  } else if (provider === "claude") {
    const bin = resolveBundledBinary("claude");
    if (bin) {
      const isJs = bin.endsWith(".js");
      const cmd = isJs ? process.execPath : bin;
      const args = isJs ? [bin, "auth", "logout"] : ["auth", "logout"];
      const r = spawnSync(cmd, args, {
        encoding: "utf8",
        timeout: 8000,
        env: { ...process.env, PATH: augmentedPath(), ...(isJs ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
      });
      ok = r.status === 0;
    }
  } else if (provider === "gemini") {
    const s = loadSettings();
    saveSettings({ ...s, geminiApiKey: "" });
    ok = true;
  } else if (provider === "pi") {
    const s = loadSettings();
    saveSettings({ ...s, piApiKey: "", piUrl: "" });
    ok = true;
  }

  resetUsage(provider);
  return NextResponse.json({ ok });
}
