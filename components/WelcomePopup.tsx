"use client";

/**
 * First-launch popups, shown in sequence on every app boot:
 *
 *   1. Welcome card: who built Get It. and how to reach us.
 *   2. Community card: an open invitation to help build Get It. on Discord.
 *
 * The two are fully independent. Each has its own "Don't show again" that
 * pins the dismissal to the current app version via /api/welcome (keyed by
 * "welcome" / "community"), and its own once-per-session dismissal. So a user
 * can hide the welcome card forever and still be invited to the community, or
 * vice versa. A future update bumps the version and both reappear for the new
 * release.
 *
 * Renders nothing until /api/welcome has answered, and nothing once the user
 * has nothing left to see.
 */

import { useCallback, useEffect, useState } from "react";
import {
  APP_VERSION,
  GITHUB_URL,
  FEEDBACK_EMAIL,
  DISCORD_URL,
  TEAM,
} from "@/lib/version";
import {
  X,
  ExternalLink,
  Mail,
  MessageCircle,
  Code,
  GitPullRequest,
  Heart,
} from "lucide-react";

type PopupKey = "welcome" | "community";

// sessionStorage keys that say "the user dismissed this popup during this
// session". Survives client-side navigations between pages, gone when the
// Electron BrowserWindow is recreated at next app launch. We keep both this
// in-session flag AND the durable "Don't show again" file in user-data:
// closing dismisses for the session; "Don't show again" persists across boots.
const SESSION_DISMISS_PREFIX = "getit:popup:dismissed-session:";

function dismissedThisSession(key: PopupKey): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(SESSION_DISMISS_PREFIX + key) === "1";
  } catch {
    return false;
  }
}

function markDismissedThisSession(key: PopupKey): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SESSION_DISMISS_PREFIX + key, "1");
  } catch {
    /* private-mode fallback: the popup just shows once per mount, fine */
  }
}

async function serverShouldShow(key: PopupKey): Promise<boolean> {
  try {
    const r = await fetch(`/api/welcome?key=${key}`, { cache: "no-store" });
    if (!r.ok) return false;
    const s = (await r.json()) as { shouldShow?: boolean };
    return !!s.shouldShow;
  } catch {
    return false;
  }
}

async function dismissForeverOnServer(key: PopupKey): Promise<void> {
  try {
    await fetch("/api/welcome", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
  } catch {
    /* ignore: the session flag still hides it for now */
  }
}

type Stage = "loading" | "welcome" | "community" | "done";

export default function WelcomePopup() {
  const [stage, setStage] = useState<Stage>("loading");
  // Whether the community card is eligible to appear at all this session.
  // Computed once on load so dismissing the welcome card forever never
  // suppresses the community invite that follows it.
  const [communityEligible, setCommunityEligible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const welcomeEligible =
        !dismissedThisSession("welcome") && (await serverShouldShow("welcome"));
      const community =
        !dismissedThisSession("community") &&
        (await serverShouldShow("community"));
      if (cancelled) return;
      setCommunityEligible(community);
      setStage(welcomeEligible ? "welcome" : community ? "community" : "done");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Leave the welcome card → hand off to the community card if it's eligible.
  const afterWelcome = useCallback(() => {
    markDismissedThisSession("welcome");
    setStage(communityEligible ? "community" : "done");
  }, [communityEligible]);

  const closeWelcome = useCallback(() => {
    afterWelcome();
  }, [afterWelcome]);

  const dismissWelcomeForever = useCallback(async () => {
    void dismissForeverOnServer("welcome");
    afterWelcome();
  }, [afterWelcome]);

  const closeCommunity = useCallback(() => {
    markDismissedThisSession("community");
    setStage("done");
  }, []);

  const dismissCommunityForever = useCallback(async () => {
    markDismissedThisSession("community");
    void dismissForeverOnServer("community");
    setStage("done");
  }, []);

  if (stage === "welcome") {
    return <WelcomeCard onClose={closeWelcome} onDismissForever={dismissWelcomeForever} />;
  }
  if (stage === "community") {
    return (
      <CommunityCard
        onClose={closeCommunity}
        onDismissForever={dismissCommunityForever}
      />
    );
  }
  return null;
}

// ── Shared modal shell ────────────────────────────────────────────────────

function Backdrop({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-6"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl bg-[var(--surface-raised)] shadow-[var(--shadow-modal)]">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-[var(--ink-400)] transition hover:bg-[var(--surface-canvas)] hover:text-[var(--ink-900)]"
        >
          <X className="h-4 w-4" />
        </button>
        {children}
      </div>
    </div>
  );
}

function DismissRow({
  onDismissForever,
  primaryLabel,
  onPrimary,
  primaryHref,
}: {
  onDismissForever: () => void;
  primaryLabel: string;
  onPrimary: () => void;
  primaryHref?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-canvas)] px-6 py-3">
      <button
        type="button"
        onClick={onDismissForever}
        className="text-[11.5px] font-medium text-[var(--ink-500)] underline-offset-2 hover:text-[var(--ink-900)] hover:underline"
      >
        Don&apos;t show again
      </button>
      {primaryHref ? (
        <a
          href={primaryHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onPrimary}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3.5 py-1.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:bg-[var(--button-primary-hover)]"
        >
          {primaryLabel}
        </a>
      ) : (
        <button
          type="button"
          onClick={onPrimary}
          className="rounded-md bg-[var(--button-primary-bg)] px-3.5 py-1.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:bg-[var(--button-primary-hover)]"
        >
          {primaryLabel}
        </button>
      )}
    </div>
  );
}

// ── Card 1: founders' welcome ─────────────────────────────────────────────

function WelcomeCard({
  onClose,
  onDismissForever,
}: {
  onClose: () => void;
  onDismissForever: () => void;
}) {
  return (
    <Backdrop onClose={onClose}>
      <div className="px-6 pb-2 pt-7">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-700)]">
          VERSION {APP_VERSION}
        </div>
        <h2 className="mt-2 text-[22px] font-bold tracking-tight text-[var(--ink-900)]">
          Welcome to{" "}
          <span className="font-black text-[var(--ink-900)]">Get It.</span>
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--ink-700)]">
          Four students. 24h at <strong>GDG AI Hack 2026, Milan</strong>. One
          conviction: getting a concept fast is half the battle, and the other
          half is knowing you actually got it. We built Get It. to do both, then
          made it free for every student who needs the same.
        </p>
      </div>

      <ul className="mx-6 mt-3 space-y-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-canvas)] px-4 py-3">
        {TEAM.map((m) => (
          <li
            key={m.name}
            className="flex items-baseline justify-between text-[12.5px]"
          >
            <a
              href={m.linkedin}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--ink-900)] underline-offset-2 hover:text-[var(--accent-700)] hover:underline"
            >
              {m.name}
            </a>
            <span className="text-[10.5px] text-[var(--ink-500)]">
              {m.affiliation}
            </span>
          </li>
        ))}
      </ul>

      <div className="mx-6 my-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-3 text-[12px] leading-relaxed text-[var(--ink-700)]">
        <p>
          <strong>Free, forever, and yours to shape.</strong> Your documents
          and study journal never leave this computer: no accounts, no cloud
          sync. Got a bug, a missing feature, or code you want to send our way?
          Tell us, we&apos;re listening.
        </p>
        <div className="mt-3 flex flex-col gap-1.5">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--accent-700)] hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {GITHUB_URL.replace(/^https?:\/\//, "")}
          </a>
          <a
            href={DISCORD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--accent-700)] hover:underline"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            Join our Discord community
          </a>
          <a
            href={`mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(
              `Get It. ${APP_VERSION} feedback`,
            )}`}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--accent-700)] hover:underline"
          >
            <Mail className="h-3.5 w-3.5" />
            {FEEDBACK_EMAIL}
          </a>
        </div>
      </div>

      <DismissRow
        onDismissForever={onDismissForever}
        primaryLabel="Let's go"
        onPrimary={onClose}
      />
    </Backdrop>
  );
}

// ── Card 2: open-source / community invite ────────────────────────────────

function CommunityCard({
  onClose,
  onDismissForever,
}: {
  onClose: () => void;
  onDismissForever: () => void;
}) {
  return (
    <Backdrop onClose={onClose}>
      <div className="px-6 pb-2 pt-7">
        <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-700)]">
          <Code className="h-3.5 w-3.5" />
          Open source
        </div>
        <h2 className="mt-2 text-[22px] font-bold tracking-tight text-[var(--ink-900)]">
          Help us build{" "}
          <span className="font-black text-[var(--ink-900)]">Get It.</span>
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--ink-700)]">
          We open sourced Get It. for a reason: the best study tool should be
          built in the open, by the people who actually use it. We are a tiny
          team and there is a lot still to build, so we need you.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--ink-700)]">
          If you write code, you can shape what Get It. becomes. Maintainers,
          contributors, designers, and anyone with sharp ideas are all welcome.
          Pick an issue, send a pull request, or just come tell us what you
          would build next.
        </p>
      </div>

      <div className="mx-6 my-4 rounded-xl border border-[var(--accent-100)] bg-[var(--accent-50)] px-4 py-3.5">
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-[var(--ink-700)]">
          <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-700)]" />
          <span>
            Everything is organised on our Discord: that is where we plan
            features, review work, and help each other ship. Come say hi and
            grab something to build.
          </span>
        </p>
        <div className="mt-3 flex flex-col gap-1.5">
          <a
            href={`${GITHUB_URL}/blob/main/CONTRIBUTING.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--accent-700)] hover:underline"
          >
            <GitPullRequest className="h-3.5 w-3.5" />
            Read the contributing guide
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--accent-700)] hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Browse the code and open issues
          </a>
        </div>
      </div>

      <p className="mx-6 mb-4 flex items-center gap-1.5 text-[11.5px] text-[var(--ink-500)]">
        <Heart className="h-3.5 w-3.5 text-[var(--accent-600)]" />
        Built by students, kept free, made better by people like you.
      </p>

      <DismissRow
        onDismissForever={onDismissForever}
        primaryLabel="Join the community"
        onPrimary={onClose}
        primaryHref={DISCORD_URL}
      />
    </Backdrop>
  );
}
