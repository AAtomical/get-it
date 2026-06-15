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
    autoGenerate:
      typeof b.autoGenerate === "boolean" ? b.autoGenerate : current.autoGenerate,
    maxRetries:
      typeof b.maxRetries === "number" && b.maxRetries >= 0
        ? b.maxRetries
        : current.maxRetries,
  };
  next.theme = current.theme;
  if (b.theme === "light" || b.theme === "dark") {
    next.theme = b.theme;
  } else if (b.theme === null) {
    // Explicitly clearing the theme preference (back to system).
    delete next.theme;
  }
  saveSettings(next);
  return NextResponse.json(next);
}
