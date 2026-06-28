/**
 * Claude Code provider — invokes `claude` as a subprocess.
 *
 * CLI invocation:
 *   claude -p "<prompt>" --output-format json --json-schema <schema>
 *
 * JSON output shape:
 *   { type, subtype, result, total_cost_usd, session_id, duration_ms, num_turns, is_error }
 *
 * Thread support:
 *   Uses native --resume <session-id> with session_id from previous output.
 *
 * --json-schema constrains the `result` field to match the output schema.
 * We intentionally do NOT pass --bare: that "minimal mode" skips the plugin/
 * settings load that subscription (OAuth) logins rely on, so it breaks auth
 * for those users ("Not logged in"). Hermeticity instead comes from running
 * in an empty scratch cwd, which has no project-level CLAUDE.md.
 */

import { CODEX_SCRATCH_DIR } from "../paths";
import type {
  AIProvider,
  RunOptions,
  RunJsonResult,
  RunJsonInThreadResult,
} from "../provider-types";
import { whichBinary, runCliBinary, parseJsonResponse, resolveBundledBinary } from "./cli-runner";
import { loadSettings } from "../settings-store";

// Heavy generations (a full viz spec, especially with high thinking effort on
// opus) routinely run past the 120s cli-runner default — which SIGTERMs the
// process and surfaces as "exited with code 143". Match Gemini's generous cap.
const CLAUDE_TIMEOUT_MS = 600_000;

type ClaudeJsonOutput = {
  type: string;
  subtype: string;
  result: string;
  /** With --json-schema the constrained object is returned here (already
   *  parsed); `result` is left empty in that case. */
  structured_output?: unknown;
  total_cost_usd?: number;
  session_id?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

/** Token + cost usage for the usage store (claude reports both per call). */
function claudeUsage(raw: ClaudeJsonOutput) {
  const u = raw.usage ?? {};
  return {
    total_cost_usd: raw.total_cost_usd,
    input_tokens:
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0),
    output_tokens: u.output_tokens ?? 0,
    duration_ms: raw.duration_ms,
    num_turns: raw.num_turns,
  };
}

/**
 * Pull the schema-constrained payload out of a Claude CLI envelope. When
 * `--json-schema` is used the CLI returns the object in `structured_output`
 * and leaves `result` empty; for non-schema calls (or older CLI versions)
 * the JSON lives as text in `result`. Handle both.
 */
function extractClaudeData<T>(raw: ClaudeJsonOutput): T {
  if (raw.structured_output != null && typeof raw.structured_output === "object") {
    return raw.structured_output as T;
  }
  return parseJsonResponse<T>(raw.result);
}

let _binaryPath: string | null | undefined;

function resolveBinary(): string {
  if (_binaryPath === undefined) {
    _binaryPath = resolveBundledBinary("claude") || whichBinary("claude");
  }
  if (!_binaryPath) {
    throw new Error(
      "Claude Code CLI not found.",
    );
  }
  return _binaryPath;
}

/** Reset the cached binary path (e.g. after install). */
export function resetClaudeBinaryCache(): void {
  _binaryPath = undefined;
}

export class ClaudeProvider implements AIProvider {
  readonly name = "claude" as const;

  async runJson<T>(
    prompt: string,
    outputSchema: object,
    opts: RunOptions = {},
  ): Promise<RunJsonResult<T>> {
    const bin = resolveBinary();

    const settings = loadSettings();
    const reasoning = opts.reasoning ?? "low";
    const model = reasoning === "low"
      ? (settings.claudeModelFast || "sonnet")
      : (settings.claudeModelSmart || "opus");

    // The prompt goes over STDIN, not as a `-p <arg>`: a full-document prompt
    // (flashcards/quiz/chat/feynman) easily exceeds the OS command-line limit
    // (E2BIG → instant spawn failure), especially on Linux/Windows.
    const args = [
      "-p",
      "--model",
      model,
      "--effort",
      reasoning === "low"
        ? (settings.claudeEffortFast || settings.claudeEffort || "medium")
        : (settings.claudeEffortSmart || settings.claudeEffort || "high"),
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(outputSchema),
    ];

    const result = await runCliBinary(bin, args, {
      signal: opts.signal,
      cwd: CODEX_SCRATCH_DIR,
      timeoutMs: CLAUDE_TIMEOUT_MS,
      stdin: prompt,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr || result.stdout || `Claude CLI exited with code ${result.exitCode}`,
      );
    }

    const raw = parseJsonResponse<ClaudeJsonOutput>(result.stdout);

    if (raw.is_error) {
      throw new Error(raw.result || "Claude CLI returned an error");
    }

    const innerData = extractClaudeData<T>(raw);

    return {
      data: innerData,
      usage: claudeUsage(raw),
    };
  }

  async runJsonInThread<T>(args: {
    outputSchema: object;
    opts?: RunOptions;
    resume?: { threadId: string; input: string };
    start?: { input: string };
  }): Promise<RunJsonInThreadResult<T>> {
    const bin = resolveBinary();
    const opts = args.opts ?? {};

    if (args.resume) {
      const settings = loadSettings();
      const reasoning = opts.reasoning ?? "low";
      const model = reasoning === "low" 
        ? (settings.claudeModelFast || "sonnet")
        : (settings.claudeModelSmart || "opus");

      // Use --resume <session-id> for thread continuation; the turn input goes
      // over STDIN (never as a `-p <arg>`) to avoid the command-line size limit.
      const cliArgs = [
        "--resume",
        args.resume.threadId,
        "-p",
        "--model",
        model,
        "--effort",
      reasoning === "low"
        ? (settings.claudeEffortFast || settings.claudeEffort || "medium")
        : (settings.claudeEffortSmart || settings.claudeEffort || "high"),
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(args.outputSchema),
      ];

      const result = await runCliBinary(bin, cliArgs, {
        signal: opts.signal,
        cwd: CODEX_SCRATCH_DIR,
        timeoutMs: CLAUDE_TIMEOUT_MS,
        stdin: args.resume.input,
      });

      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr ||
            result.stdout ||
            `Claude CLI resume exited with code ${result.exitCode}`,
        );
      }

      const raw = parseJsonResponse<ClaudeJsonOutput>(result.stdout);
      if (raw.is_error) {
        throw new Error(raw.result || "Claude CLI returned an error");
      }

      const innerData = extractClaudeData<T>(raw);

      return {
        data: innerData,
        usage: claudeUsage(raw),
        threadId: raw.session_id ?? args.resume.threadId,
      };
    }

    if (!args.start)
      throw new Error("runJsonInThread: provide `start` or `resume`");

    const settings = loadSettings();
    const reasoning = opts.reasoning ?? "low";
    const model = reasoning === "low"
      ? (settings.claudeModelFast || "sonnet")
      : (settings.claudeModelSmart || "opus");

    const cliArgs = [
      "-p",
      "--model",
      model,
      "--effort",
      reasoning === "low"
        ? (settings.claudeEffortFast || settings.claudeEffort || "medium")
        : (settings.claudeEffortSmart || settings.claudeEffort || "high"),
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(args.outputSchema),
    ];

    const result = await runCliBinary(bin, cliArgs, {
      signal: opts.signal,
      cwd: CODEX_SCRATCH_DIR,
      timeoutMs: CLAUDE_TIMEOUT_MS,
      stdin: args.start.input,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr ||
          result.stdout ||
          `Claude CLI exited with code ${result.exitCode}`,
      );
    }

    const raw = parseJsonResponse<ClaudeJsonOutput>(result.stdout);
    if (raw.is_error) {
      throw new Error(raw.result || "Claude CLI returned an error");
    }

    const innerData = extractClaudeData<T>(raw);

    return {
      data: innerData,
      usage: claudeUsage(raw),
      threadId: raw.session_id ?? null,
    };
  }
}
