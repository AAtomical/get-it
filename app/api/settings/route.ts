/**
 * GET  /api/settings    → current persisted AppSettings (or env defaults)
 * POST /api/settings    → merge body into persisted settings
 *
 * The viewer reads this once at mount and writes on every toggle. Settings
 * survive app restarts because they live at <DATA_DIR>/settings.json.
 */

import { NextResponse } from "next/server";
import { loadSettings, saveSettings, type AppSettings } from "@/lib/settings-store";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(loadSettings());
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const b = (body && typeof body === "object" ? body : {}) as Partial<AppSettings>;
  const current = loadSettings();
  const next: AppSettings = {
    provider:
      ["codex", "gemini", "claude", "pi"].includes(b.provider as string)
        ? b.provider!
        : current.provider,
    codexModelFast: typeof b.codexModelFast === "string" ? b.codexModelFast : current.codexModelFast,
    codexModelSmart: typeof b.codexModelSmart === "string" ? b.codexModelSmart : current.codexModelSmart,
    codexEffortFast: typeof b.codexEffortFast === "string" ? b.codexEffortFast : current.codexEffortFast,
    codexEffortSmart: typeof b.codexEffortSmart === "string" ? b.codexEffortSmart : current.codexEffortSmart,
    geminiApiKey: typeof b.geminiApiKey === "string" ? b.geminiApiKey : current.geminiApiKey,
    geminiModelFast: typeof b.geminiModelFast === "string" ? b.geminiModelFast : current.geminiModelFast,
    geminiModelSmart: typeof b.geminiModelSmart === "string" ? b.geminiModelSmart : current.geminiModelSmart,
    claudeModelFast: typeof b.claudeModelFast === "string" ? b.claudeModelFast : current.claudeModelFast,
    claudeModelSmart: typeof b.claudeModelSmart === "string" ? b.claudeModelSmart : current.claudeModelSmart,
    claudeEffort: typeof b.claudeEffort === "string" ? b.claudeEffort : current.claudeEffort,
    autoGenerate:
      typeof b.autoGenerate === "boolean" ? b.autoGenerate : current.autoGenerate,
    maxRetries:
      typeof b.maxRetries === "number" && b.maxRetries >= 0
        ? b.maxRetries
        : current.maxRetries,
    piUrl: typeof b.piUrl === "string" ? b.piUrl : current.piUrl,
    piApiKey: typeof b.piApiKey === "string" ? b.piApiKey : current.piApiKey,
    piModelFast:
      typeof b.piModelFast === "string" ? b.piModelFast : current.piModelFast,
    piModelSmart:
      typeof b.piModelSmart === "string" ? b.piModelSmart : current.piModelSmart,
    piProvider: typeof b.piProvider === "string" ? b.piProvider : current.piProvider,
    piApiType: typeof b.piApiType === "string" ? b.piApiType : current.piApiType,
  };
  saveSettings(next);
  return NextResponse.json(next);
}
