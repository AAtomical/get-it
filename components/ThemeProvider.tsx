"use client";

import { useCallback, useEffect } from "react";
import { SETTINGS_EVENT } from "@/components/SettingsButton";

function applyTheme(theme: string | undefined) {
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else if (theme === "light") {
    document.documentElement.classList.remove("dark");
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", prefersDark);
  }
}

export default function ThemeProvider({
  children,
  initialTheme,
}: {
  children: React.ReactNode;
  initialTheme?: "light" | "dark";
}) {
  // No async fetch needed — the root layout sets the class during SSR and a
  // blocking inline script handles the system-preference fallback. This
  // component only reacts to live custom events and system preference changes.
  const reapply = useCallback(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((s: { theme?: string }) => applyTheme(s.theme))
      .catch(() => applyTheme(undefined));
  }, []);

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

  // Re-evaluate when system preference changes — always fetch current
  // persisted theme so explicit choices aren't overridden.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { reapply(); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [reapply]);

  return <>{children}</>;
}
