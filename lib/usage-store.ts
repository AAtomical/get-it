/**
 * Per-provider, per-DAY token-usage tracker.
 *
 * Every AI call flows through lib/codex.ts, which records the call's token
 * usage here. The account panel reads it to show "tokens today" for every
 * engine that has no readable subscription-limit surface (Claude, Gemini, Pi,
 * and Codex on an API key) — Codex on a ChatGPT login shows its own 5h/weekly
 * limits instead.
 *
 * Counts are scoped to the local calendar day and reset automatically at
 * midnight: each provider's record carries the `day` it belongs to, and a read
 * or record for a new day starts that provider fresh. Engines are tracked
 * independently, so switching provider never mixes their numbers.
 *
 * Raw per-call usage shapes differ by provider; `normalizeUsage` maps each to
 * a common { inputTokens, outputTokens, costUsd } delta. All paths swallow
 * their own errors — usage tracking must never break or slow an AI call.
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";
import type { ProviderName } from "./provider-types";

export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** USD cost when the provider reports it (Claude, Pi); 0 otherwise. */
  costUsd: number;
  calls: number;
  /** Local calendar day (YYYY-MM-DD) these counts belong to; resets daily. */
  day: string | null;
  /** Start of the current day's counting (ms epoch). */
  since: number | null;
  updatedAt: number | null;
};

const ZERO: ProviderUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  calls: 0,
  day: null,
  since: null,
  updatedAt: null,
};

type UsageFile = Partial<Record<ProviderName, ProviderUsage>>;

function usagePath(): string {
  return path.join(DATA_DIR, "usage.json");
}

/** Local calendar day, e.g. "2026-06-29" (en-CA renders ISO YYYY-MM-DD). */
function todayKey(): string {
  return new Date().toLocaleDateString("en-CA");
}

function load(): UsageFile {
  try {
    return JSON.parse(fs.readFileSync(usagePath(), "utf-8")) as UsageFile;
  } catch {
    return {};
  }
}

function persist(all: UsageFile): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(usagePath(), JSON.stringify(all), "utf-8");
  } catch {
    /* best-effort */
  }
}

export function readUsage(provider: ProviderName): ProviderUsage {
  const cur = { ...ZERO, ...(load()[provider] ?? {}) };
  // A record from a previous day reads as zero — today's usage hasn't started.
  if (cur.day !== todayKey()) return { ...ZERO, day: todayKey() };
  return cur;
}

export function resetUsage(provider: ProviderName): void {
  const all = load();
  delete all[provider];
  persist(all);
}

export type UsageDelta = { inputTokens: number; outputTokens: number; costUsd: number };

/** Add one call's usage to a provider's running total for the current day. */
export function recordUsage(provider: ProviderName, delta: UsageDelta): void {
  try {
    const all = load();
    const today = todayKey();
    const stored = all[provider];
    // Start a fresh bucket when there's nothing yet or the stored counts belong
    // to an earlier day (daily reset).
    const cur =
      stored && stored.day === today ? { ...ZERO, ...stored } : { ...ZERO, day: today };
    const now = Date.now();
    cur.inputTokens += Math.max(0, delta.inputTokens || 0);
    cur.outputTokens += Math.max(0, delta.outputTokens || 0);
    cur.totalTokens = cur.inputTokens + cur.outputTokens;
    cur.costUsd += Math.max(0, delta.costUsd || 0);
    cur.calls += 1;
    cur.day = today;
    cur.since = cur.since ?? now;
    cur.updatedAt = now;
    all[provider] = cur;
    persist(all);
  } catch {
    /* never break a call over usage tracking */
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Map a provider's raw per-call `usage` object to a common token/cost delta.
 * Defensive: unknown shapes yield zeros (the call still counts).
 */
export function normalizeUsage(provider: ProviderName, raw: unknown): UsageDelta {
  if (!raw || typeof raw !== "object") return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const u = raw as Record<string, unknown>;

  if (provider === "codex") {
    // @openai/codex-sdk Usage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }
    return {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens) + num(u.reasoning_output_tokens),
      costUsd: 0,
    };
  }
  if (provider === "claude") {
    // claude-provider returns { total_cost_usd, input_tokens, output_tokens, ... }
    return {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      costUsd: num(u.total_cost_usd) || num(u.costUsd),
    };
  }
  if (provider === "gemini") {
    // gemini stats: { prompt_token_count, candidates_token_count, total_token_count }
    return {
      inputTokens: num(u.prompt_token_count),
      outputTokens: num(u.candidates_token_count),
      costUsd: 0,
    };
  }
  // pi: { input, output, cacheRead, cacheWrite, totalTokens, cost: { total } }
  const cost = u.cost && typeof u.cost === "object" ? (u.cost as Record<string, unknown>) : null;
  return {
    inputTokens: num(u.input),
    outputTokens: num(u.output),
    costUsd: cost ? num(cost.total) : 0,
  };
}
