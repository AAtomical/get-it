"use client";

/**
 * Top-bar Account button + popover. One coherent panel for every provider:
 *
 *   • Identity (email / plan) when connected, or a "Connect" prompt.
 *   • Usage — subscription LIMITS only for engines that expose them (Codex on
 *     a ChatGPT login: 5h/weekly), or per-day TOKENS for everyone else
 *     (Claude, Gemini, Pi, and Codex on an API key) where no limit is readable.
 *   • Provider-agnostic Sign out + Switch provider, both routed through the
 *     single setup wizard.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CircleUserRound,
  LogOut,
  RefreshCw,
  User as UserIcon,
  XCircle,
  ExternalLink,
  Settings2,
  Gauge,
} from "lucide-react";

import type { ProviderName } from "@/lib/provider-types";

type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
  since: number | null;
  updatedAt: number | null;
};

type RateWindow = {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number | null;
} | null;

type ProviderStatus = {
  provider: ProviderName;
  label: string;
  docsUrl: string;
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  authMode: "account" | "apiKey" | null;
  /** True only for Codex on a ChatGPT login (5h/weekly limits); everything
   *  else shows daily token usage. */
  exposesLimits?: boolean;
  account: {
    email: string | null;
    name: string | null;
    planType: string | null;
  } | null;
  rateLimits: {
    primary: RateWindow;
    secondary: RateWindow;
    credits: { hasCredits: boolean; unlimited: boolean; balance: string } | null;
  } | null;
  usage: ProviderUsage | null;
};

// `window.getit` is declared globally in components/CodexHealthBanner.tsx.

export default function AccountButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <span className="viz-tooltip-anchor relative inline-flex">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="tab-icon-btn"
          aria-label="Account"
        >
          <CircleUserRound className="h-3.5 w-3.5" />
        </button>
        {!open && (
          <span className="viz-tooltip" role="tooltip">
            AI provider account, usage and sign-out.
          </span>
        )}
      </span>
      <AnimatePresence>
        {open && (
          <motion.div
            key="account-menu"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 top-full z-30 mt-1.5 w-[22rem] overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-[var(--shadow-popover)]"
          >
            <AccountPanel open={open} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function openSetup() {
  if (typeof window !== "undefined" && window.getit?.runCodexSetup) {
    window.getit.runCodexSetup().catch(() => {});
  }
}

function AccountPanel({ open }: { open: boolean }) {
  const [data, setData] = useState<ProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch("/api/provider/status", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as ProviderStatus;
      })
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setErr((e as Error).message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSignOut = useCallback(async () => {
    if (busy || !data) return;
    const msg =
      data.authMode === "apiKey"
        ? "Disconnect and clear the saved key for this provider? Your library and study data stay on this device."
        : "Sign out? Your library and study data stay on this device.";
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      await fetch("/api/provider/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: data.provider }),
      });
    } catch {
      /* ignore */
    }
    setBusy(false);
    openSetup();
  }, [busy, data]);

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center justify-between">
        <p className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-500)]">
          {data?.label ?? "AI Provider"} account
        </p>
        {data?.authenticated && (
          <button
            type="button"
            onClick={handleSignOut}
            disabled={busy}
            title={data.authMode === "apiKey" ? "Disconnect / clear key" : "Sign out and return to setup"}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--ink-700)] transition hover:border-[var(--feedback-wrong-border)] hover:bg-[var(--feedback-wrong-bg)] hover:text-[var(--feedback-wrong-text)] disabled:opacity-50"
          >
            {busy ? <RefreshCw className="h-2.5 w-2.5 animate-spin" /> : <LogOut className="h-2.5 w-2.5" />}
            {busy ? "…" : data.authMode === "apiKey" ? "Disconnect" : "Sign out"}
          </button>
        )}
      </div>

      {loading && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--ink-400)]">
          <RefreshCw className="h-3 w-3 animate-spin text-[var(--accent-600)]" />
          fetching status…
        </div>
      )}

      {!loading && (err || !data) && (
        <p className="mt-1.5 text-[11px] text-[var(--ink-400)]">No data.</p>
      )}

      {!loading && data && (
        <>
          {/* Identity */}
          {data.authenticated && data.account ? (
            <div className="mt-1.5 flex items-center gap-2">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-sunken)] text-[var(--ink-500)]">
                <UserIcon className="h-3 w-3" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-medium text-[var(--ink-900)]">
                  {data.account.name ?? data.account.email ?? "Connected"}
                </p>
                <p className="truncate text-[10.5px] text-[var(--ink-500)]">
                  {data.account.email && data.account.email !== data.account.name ? data.account.email : ""}
                  {data.account.planType ? (
                    <>
                      {data.account.email && data.account.email !== data.account.name ? " · " : ""}
                      <span className="font-medium uppercase text-[var(--accent-700)]">
                        {data.account.planType}
                      </span>
                    </>
                  ) : null}
                </p>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-sunken)] text-[var(--ink-500)]">
                <XCircle className="h-3.5 w-3.5 text-rose-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium text-[var(--ink-900)]">{data.label}</p>
                <p className="text-[10.5px] text-[var(--ink-500)]">
                  {data.authMode === "apiKey" ? "No API key set" : "Not signed in"}
                  {data.version ? ` · v${data.version}` : ""}
                </p>
              </div>
            </div>
          )}

          {/* The view is tied to whether the engine EXPOSES limits, not to the
              auth mode: only Codex on a ChatGPT login surfaces 5h/weekly windows
              and keeps showing them (a transient read miss shows a placeholder,
              never a silent flip to tokens). Every other engine — Claude (no
              limit surface), Gemini, Pi, Codex-on-API-key — shows daily token
              usage instead. */}
          {data.exposesLimits ? (
            data.rateLimits && (data.rateLimits.primary || data.rateLimits.secondary) ? (
              <div className="mt-4 space-y-1.5">
                <LimitRow label="5h limit" win={data.rateLimits.primary} />
                <LimitRow label="Weekly limit" win={data.rateLimits.secondary} />
              </div>
            ) : data.authenticated ? (
              <div className="mt-4 text-[10.5px] text-[var(--ink-400)]">
                Usage limits unavailable right now — they&apos;ll reappear shortly.
              </div>
            ) : null
          ) : data.authenticated && data.usage && data.usage.calls > 0 ? (
            <UsageRow usage={data.usage} showCost={data.authMode === "apiKey"} />
          ) : data.authenticated ? (
            <div className="mt-4 text-[10.5px] text-[var(--ink-400)]">
              No tokens used today yet.
            </div>
          ) : null}

          {/* Actions */}
          <div className="mt-4 flex items-center gap-2">
            <a
              href={data.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1 text-[10.5px] font-medium text-[var(--ink-700)] transition hover:border-[var(--accent-300)] hover:text-[var(--accent-700)]"
            >
              <ExternalLink className="h-2.5 w-2.5" />
              Help
            </a>
            <button
              type="button"
              onClick={openSetup}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1 text-[10.5px] font-medium text-[var(--ink-700)] transition hover:border-[var(--accent-300)] hover:text-[var(--accent-700)]"
            >
              <Settings2 className="h-2.5 w-2.5" />
              {data.authenticated ? "Switch provider" : "Connect"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function UsageRow({ usage, showCost }: { usage: ProviderUsage; showCost: boolean }) {
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between text-[11px]">
        <span className="inline-flex items-center gap-1 font-medium text-[var(--ink-700)]">
          <Gauge className="h-3 w-3 text-[var(--accent-600)]" /> Tokens today
        </span>
        <span className="tabular-nums text-[var(--ink-900)]">
          {fmtTokens(usage.totalTokens)}
          {showCost && usage.costUsd > 0 ? (
            <span className="ml-1 font-normal text-[var(--ink-400)]">· ${usage.costUsd.toFixed(2)}</span>
          ) : null}
        </span>
      </div>
      <p className="mt-1 text-[10.5px] text-[var(--ink-400)]">
        {fmtTokens(usage.inputTokens)} in · {fmtTokens(usage.outputTokens)} out · {usage.calls} call{usage.calls === 1 ? "" : "s"}
      </p>
    </div>
  );
}

function LimitRow({ label, win }: { label: string; win: RateWindow }) {
  if (!win) {
    return (
      <div className="flex items-center justify-between text-[10.5px] text-[var(--ink-400)]">
        <span>{label}</span>
        <span>no data</span>
      </div>
    );
  }
  const used = Math.max(0, Math.min(100, Math.round(win.usedPercent)));
  const tone = used >= 90 ? "bg-rose-500" : used >= 60 ? "bg-amber-500" : "bg-[var(--accent-600)]";
  const resetIn = win.resetsAt ? formatResetIn(win.resetsAt * 1000) : null;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-[var(--ink-700)]">{label}</span>
        <span className="tabular-nums text-[var(--ink-900)]">
          {used}% used
          {resetIn ? <span className="ml-1 font-normal text-[var(--ink-400)]">· resets in {resetIn}</span> : null}
        </span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]">
        <div className={`h-full ${tone}`} style={{ width: `${used}%` }} />
      </div>
    </div>
  );
}

function formatResetIn(absMs: number): string {
  const dt = absMs - Date.now();
  if (dt <= 0) return "now";
  const totalMin = Math.round(dt / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 48) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}
