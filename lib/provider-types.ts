/**
 * Shared types for the multi-provider AI backend system.
 *
 * Every provider (Codex SDK, Gemini CLI, Claude Code) implements the
 * `AIProvider` interface. The router in codex.ts delegates to whichever
 * provider the user selected in Settings.
 */

/** The three supported AI backends. */
export type ProviderName = "codex" | "gemini" | "claude" | "pi";

/** Human-readable display names used in the UI. */
export const PROVIDER_LABELS: Record<ProviderName, string> = {
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  claude: "Claude Code",
  pi: "Pi Coder (BYOK)",
};

/** CLI binary names used for PATH detection. */
export const PROVIDER_BINARIES: Record<ProviderName, string> = {
  codex: "codex",
  gemini: "gemini",
  claude: "claude",
  pi: "pi-coder",
};

/** npm package names for auto-install. */
export const PROVIDER_PACKAGES: Record<ProviderName, string> = {
  codex: "@openai/codex",
  gemini: "@google/gemini-cli",
  claude: "@anthropic-ai/claude-code",
  pi: "pi-coder",
};

/** Documentation URLs shown when auto-install fails. */
export const PROVIDER_DOCS: Record<ProviderName, string> = {
  codex: "https://github.com/openai/codex#login",
  gemini: "https://github.com/google-gemini/gemini-cli",
  claude: "https://docs.anthropic.com/en/docs/claude-code",
  pi: "https://github.com/beltromatti/get-it",
};

export type RunOptions = {
  /** Defaults to "low" — fastest answer-only model setting. */
  reasoning?: "low" | "medium" | "high";
  /** Allow live web search for this call. */
  webSearch?: boolean;
  /** AbortSignal forwarded to the underlying process. */
  signal?: AbortSignal;
};

export type RunJsonResult<T> = {
  data: T;
  usage: unknown;
};

export type RunJsonInThreadResult<T> = RunJsonResult<T> & {
  threadId: string | null;
};

/**
 * Interface that every AI provider must implement.
 *
 * The router in codex.ts delegates to the active provider — all downstream
 * consumers (agents, API routes) call the same `runJson` / `runJsonInThread`
 * signatures and never know which backend is running.
 */
export interface AIProvider {
  readonly name: ProviderName;

  runJson<T>(
    prompt: string,
    outputSchema: object,
    opts?: RunOptions,
  ): Promise<RunJsonResult<T>>;

  runJsonInThread<T>(args: {
    outputSchema: object;
    opts?: RunOptions;
    resume?: { threadId: string; input: string };
    start?: { input: string };
  }): Promise<RunJsonInThreadResult<T>>;
}
