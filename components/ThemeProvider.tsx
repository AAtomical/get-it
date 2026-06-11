"use client";

import { useCallback, useEffect, useRef } from "react";
import { SETTINGS_EVENT } from "@/components/SettingsButton";

function applyTheme(theme: string | undefined) {
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else if (theme === "light") {
    document.documentElement.classList.remove("dark");
  } else {
    // Follow system preference.
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", prefersDark);
  }
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const appliedRef = useRef(false);

  const sync = useCallback(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((s: { theme?: string }) => {
        applyTheme(s.theme);
        appliedRef.current = true;
      })
      .catch(() => {
        // Fall back to system preference on error.
        applyTheme(undefined);
        appliedRef.current = true;
      });
  }, []);

  useEffect(() => {
    sync();
  }, [sync]);

  // Listen for live changes from the settings popover.
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as { theme?: string } | undefined;
      if (detail && "theme" in detail) {
        applyTheme(detail.theme);
      }
    };
    window.addEventListener(SETTINGS_EVENT, onChange);
    return () => window.removeEventListener(SETTINGS_EVENT, onChange);
  }, []);

  // Re-evaluate when system preference changes (only matters when no explicit theme).
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => sync();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [sync]);

  return <>{children}</>;
}
