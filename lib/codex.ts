/**
 * AI provider router — public API for the entire app.
 *
 * This file is the ONLY entry point every agent, API route, and job
 * queue uses for AI calls. It exposes the exact same public surface as
 * the original Codex-only version:
 *
 *   - runJson<T>(prompt, schema, opts?)          → one-shot JSON
 *   - runJsonInThread<T>({ start|resume, … })    → multi-turn JSON
 *   - CodexError, CodexErrorKind                 → structured errors
 *   - getCodexHealth(), classifyCodexError()      → health/error system
 *
 * Internally it reads `loadSettings().provider` and delegates to the
 * active AIProvider implementation (Codex SDK, Gemini CLI, Claude Code, or BYOK).
 *
 * The health tracking, preflight rate-limit guard, and error classification
 * are provider-agnostic — every provider's thrown errors get classified
 * through the same regex battery and surfaced in the same banner.
 *
 * Note on naming: we keep the "Codex" names (CodexError, CodexHealth, etc.)
 * in the public API so that no downstream file needs import changes.
 */

import { loadSettings } from "./settings-store";
import type { AIProvider, RunOptions as ProviderRunOptions } from "./provider-types";
import type { ProviderName } from "./provider-types";
import { PROVIDER_LABELS } from "./provider-types";
import { CodexProvider } from "./providers/codex-provider";
import { GeminiProvider } from "./providers/gemini-provider";
import { ClaudeProvider } from "./providers/claude-provider";
import { PiProvider } from "./providers/pi-provider";
import { CodexError, classifyCodexError, toCodexErrorPayload as toErrorPayloadBase } from "./codex-errors";
import type { CodexErrorKind } from "./codex-errors";
import { recordUsage, normalizeUsage } from "./usage-store";

// Re-export RunOptions from here so existing imports keep working.
// Add back the threadOverrides for Codex-specific callers.
export type RunOptions = ProviderRunOptions & {
  /** Override default thread options (Codex-specific, ignored by CLI providers). */
  threadOverrides?: Record<string, unknown>;
};

// Pure error model + presentation live in codex-errors.ts
export {
  CodexError,
  classifyCodexError,
} from "./codex-errors";

/**
 * Provider-aware error payload: fills the friendly message with the ACTIVE
 * engine's label (so the UI says "Claude Code"/"Gemini CLI"/… instead of a
 * hard-coded "Codex"). All API routes import this from here.
 */
export function toCodexErrorPayload(err: unknown): { kind: CodexErrorKind; message: string } {
  let label = "the AI engine";
  try {
    label = PROVIDER_LABELS[loadSettings().provider] ?? label;
  } catch {
    /* fall back to the generic label */
  }
  return toErrorPayloadBase(err, label);
}
export type { CodexErrorKind } from "./codex-errors";

// ── Provider singletons ─────────────────────────────────────────────────
const providers: Record<ProviderName, AIProvider> = {
  codex: new CodexProvider(),
  gemini: new GeminiProvider(),
  claude: new ClaudeProvider(),
  pi: new PiProvider(),
};

function activeProvider(): AIProvider {
  const name = loadSettings().provider;
  return providers[name] ?? providers.codex;
}

/** Return the currently-selected provider name. */
export function getActiveProviderName(): ProviderName {
  return loadSettings().provider;
}

// ── Health mailbox ──────────────────────────────────────────────────────
export type CodexHealth = {
  ok: boolean;
  kind: CodexErrorKind | null;
  message: string | null;
  retryAt: number | null;
  window: "5h" | "weekly" | "unknown" | null;
  serial: number;
  lastOkAt: number | null;
};

type HealthMap = Record<ProviderName, CodexHealth>;

declare global {
  // eslint-disable-next-line no-var
  var __getitHealthState: HealthMap | undefined;
}

const _initialHealth: CodexHealth = {
  ok: true,
  kind: null,
  message: null,
  retryAt: null,
  window: null,
  serial: 0,
  lastOkAt: null,
};

const healthMap: HealthMap = globalThis.__getitHealthState ?? (globalThis.__getitHealthState = {
  codex: { ..._initialHealth },
  gemini: { ..._initialHealth },
  claude: { ..._initialHealth },
  pi: { ..._initialHealth },
});

function getHealth(providerName?: ProviderName): CodexHealth {
  return healthMap[providerName ?? getActiveProviderName()];
}

export function getCodexHealth(): CodexHealth {
  const health = getHealth();
  if (
    health.kind === "rate_limit" &&
    health.retryAt != null &&
    Date.now() >= health.retryAt
  ) {
    Object.assign(health, _initialHealth, { serial: health.serial });
  }
  return { ...health };
}

function markOk(providerName: ProviderName) {
  const health = getHealth(providerName);
  if (!health.ok) {
    Object.assign(health, _initialHealth, { serial: health.serial + 1 });
  }
  health.lastOkAt = Date.now();
  health.ok = true;
}

function markError(providerName: ProviderName, err: CodexError) {
  const health = getHealth(providerName);
  health.ok = false;
  health.kind = err.kind;
  health.message = err.message;
  health.retryAt = err.retryAt ?? null;
  health.window = err.window ?? null;
  health.serial += 1;
}

function preflightHealth(providerName: ProviderName): CodexError | null {
  const health = getHealth(providerName);
  if (
    health.kind === "rate_limit" &&
    health.retryAt != null &&
    Date.now() < health.retryAt
  ) {
    return new CodexError("rate_limit", health.message ?? "Rate limit active", {
      retryAt: health.retryAt,
      window: health.window ?? "unknown",
    });
  }
  return null;
}

// ── Universal call timeout backstop ───────────────────────────────────────
// EVERY AI call, for EVERY tool and EVERY provider, is bounded by a hard
// wall-clock cap. On timeout we abort the call's signal — which the providers
// forward to their subprocess (codex SDK signal, gemini/claude runCliBinary
// AbortSignal, pi execFile signal) so the underlying CLI is actually killed —
// then surface a clear, retryable error. This guarantees a spinner can never
// hang forever (a stuck network call, a CLI's internal rate-limit backoff,
// codex/pi which have no timeout of their own, etc.). Normal calls finish in
// seconds; this is only a safety net.
const HARD_CALL_TIMEOUT_MS = 300_000; // 5 min

function linkAbort(caller?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, HARD_CALL_TIMEOUT_MS);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear: () => {
      clearTimeout(timer);
      if (caller) caller.removeEventListener("abort", onCallerAbort);
    },
  };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Run a single turn that must return JSON conforming to the supplied schema.
 * Retries once if the model returns un-parseable text. Throws CodexError on
 * failure so callers can pattern-match on `.kind`.
 */
export async function runJson<T>(
  prompt: string,
  outputSchema: object,
  opts: RunOptions = {},
): Promise<{ data: T; usage: unknown }> {
  const providerName = getActiveProviderName();
  const preflight = preflightHealth(providerName);
  if (preflight) throw preflight;

  const link = linkAbort(opts.signal);
  try {
    const provider = providers[providerName] ?? providers.codex;
    const result = await provider.runJson<T>(prompt, outputSchema, {
      ...opts,
      signal: link.signal,
    });
    markOk(providerName);
    recordUsage(providerName, normalizeUsage(providerName, result.usage));
    return result;
  } catch (err) {
    if (link.timedOut()) {
      throw new CodexError("generic", "The AI request timed out — please try again.");
    }
    const classified = classifyCodexError(err);
    if (classified.kind !== "generic") {
      markError(providerName, classified);
    }
    throw classified;
  } finally {
    link.clear();
  }
}

/**
 * Thread-aware JSON runner for multi-turn tools (chat).
 *
 * Two modes, exactly one of which must be supplied:
 *   • start  — open a NEW thread and send the full first-turn prompt
 *   • resume — continue an EXISTING thread by `threadId`
 *
 * Rate-limit / auth / binary errors are classified and thrown immediately in
 * both modes so the health banner takes over.
 */
export async function runJsonInThread<T>(args: {
  outputSchema: object;
  opts?: RunOptions;
  resume?: { threadId: string; input: string };
  start?: { input: string };
}): Promise<{ data: T; usage: unknown; threadId: string | null }> {
  const providerName = getActiveProviderName();
  const preflight = preflightHealth(providerName);
  if (preflight) throw preflight;

  const link = linkAbort(args.opts?.signal);
  try {
    const provider = providers[providerName] ?? providers.codex;
    const result = await provider.runJsonInThread<T>({
      ...args,
      opts: { ...(args.opts ?? {}), signal: link.signal },
    });
    markOk(providerName);
    recordUsage(providerName, normalizeUsage(providerName, result.usage));
    return result;
  } catch (err) {
    if (link.timedOut()) {
      throw new CodexError("generic", "The AI request timed out — please try again.");
    }
    const classified = classifyCodexError(err);
    if (classified.kind !== "generic") {
      markError(providerName, classified);
    }
    throw classified;
  } finally {
    link.clear();
  }
}
