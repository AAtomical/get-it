/**
 * Persistent app settings.
 *
 * Source-of-truth for runtime knobs the user can toggle from the
 * Settings popover. Reads:
 *   1. Saved JSON at <DATA_DIR>/settings.json (if it exists — i.e. the
 *      user has touched the controls at some point).
 *   2. Otherwise, the build-time defaults from `.env` (NEXT_PUBLIC_*).
 *   3. Otherwise, hardcoded fallbacks.
 *
 * Saved settings survive app restarts, OS reboots, and (in the packaged
 * Electron app) the dynamic localhost port that changes between launches
 * — that's why we don't lean on localStorage here.
 */

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "./paths";
import { AUTO_GENERATE_VIZ, MAX_VIZ_GEN_RETRIES } from "./config";

export type AppSettings = {
  autoGenerate: boolean;
  maxRetries: number;
  /** Undefined means "follow system preference" (default). */
  theme?: "light" | "dark";
};

const VERSION = 1 as const;
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

function defaultsFromEnv(): AppSettings {
  return {
    autoGenerate: AUTO_GENERATE_VIZ,
    maxRetries: MAX_VIZ_GEN_RETRIES,
  };
}

export function loadSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { v: number } & Partial<AppSettings>;
    if (parsed && parsed.v === VERSION) {
      const env = defaultsFromEnv();
      const s: AppSettings = {
        autoGenerate:
          typeof parsed.autoGenerate === "boolean"
            ? parsed.autoGenerate
            : env.autoGenerate,
        maxRetries:
          typeof parsed.maxRetries === "number" && parsed.maxRetries >= 0
            ? Math.min(10, Math.floor(parsed.maxRetries))
            : env.maxRetries,
      };
      if (parsed.theme === "light" || parsed.theme === "dark") {
        s.theme = parsed.theme;
      }
      return s;
    }
  } catch {
    /* file missing or malformed — fall through to env defaults */
  }
  return defaultsFromEnv();
}

export function saveSettings(s: AppSettings): void {
  const file: Record<string, unknown> = {
    v: VERSION,
    savedAt: Date.now(),
    autoGenerate: !!s.autoGenerate,
    maxRetries: Math.min(10, Math.max(0, Math.floor(s.maxRetries))),
  };
  if (s.theme === "light" || s.theme === "dark") {
    file.theme = s.theme;
  }
  const tmp = `${SETTINGS_PATH}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, SETTINGS_PATH);
}
