/**
 * Claude Code provider — invokes `claude` as a subprocess.
 *
 * CLI invocation:
 *   claude -p "<prompt>" --output-format json --bare
 *
 * JSON output shape:
 *   { type, subtype, result, total_cost_usd, session_id, duration_ms, num_turns, is_error }
 *
 * Thread support:
 *   Uses native --resume <session-id> with session_id from previous output.
 *
 * --bare mode ensures hermetic execution (no local CLAUDE.md, hooks, or MCP servers).
 * --json-schema constrains the `result` field to match the output schema.
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

type ClaudeJsonOutput = {
  type: string;
  subtype: string;
  result: string;
  total_cost_usd?: number;
  session_id?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  is_error?: boolean;
};

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
      ? (settings.claudeModelFast || "claude-3-5-haiku-20241022") 
      : (settings.claudeModelSmart || "claude-3-7-sonnet-20250219");

    const args = [
      "-p",
      prompt,
      "--model",
      model,
      ...(settings.claudeEffort ? ["--effort", settings.claudeEffort] : []),
      "--output-format",
      "json",
      "--bare",
      "--json-schema",
      JSON.stringify(outputSchema),
    ];

    const result = await runCliBinary(bin, args, {
      signal: opts.signal,
      cwd: CODEX_SCRATCH_DIR,
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

    // The `result` field contains the schema-constrained output
    const innerData = parseJsonResponse<T>(raw.result);

    return {
      data: innerData,
      usage: {
        total_cost_usd: raw.total_cost_usd,
        duration_ms: raw.duration_ms,
        num_turns: raw.num_turns,
      },
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
        ? (settings.claudeModelFast || "claude-3-5-haiku-20241022") 
        : (settings.claudeModelSmart || "claude-3-7-sonnet-20250219");

      // Use --resume <session-id> for thread continuation
      const cliArgs = [
        "--resume",
        args.resume.threadId,
        "-p",
        args.resume.input,
        "--model",
        model,
        ...(settings.claudeEffort ? ["--effort", settings.claudeEffort] : []),
        "--output-format",
        "json",
        "--bare",
        "--json-schema",
        JSON.stringify(args.outputSchema),
      ];

      const result = await runCliBinary(bin, cliArgs, {
        signal: opts.signal,
        cwd: CODEX_SCRATCH_DIR,
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

      const innerData = parseJsonResponse<T>(raw.result);

      return {
        data: innerData,
        usage: {
          total_cost_usd: raw.total_cost_usd,
          duration_ms: raw.duration_ms,
          num_turns: raw.num_turns,
        },
        threadId: raw.session_id ?? args.resume.threadId,
      };
    }

    if (!args.start)
      throw new Error("runJsonInThread: provide `start` or `resume`");

    const settings = loadSettings();
    const reasoning = opts.reasoning ?? "low";
    const model = reasoning === "low" 
      ? (settings.claudeModelFast || "claude-3-5-haiku-20241022") 
      : (settings.claudeModelSmart || "claude-3-7-sonnet-20250219");

    const cliArgs = [
      "-p",
      args.start.input,
      "--model",
      model,
      ...(settings.claudeEffort ? ["--effort", settings.claudeEffort] : []),
      "--output-format",
      "json",
      "--bare",
      "--json-schema",
      JSON.stringify(args.outputSchema),
    ];

    const result = await runCliBinary(bin, cliArgs, {
      signal: opts.signal,
      cwd: CODEX_SCRATCH_DIR,
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

    const innerData = parseJsonResponse<T>(raw.result);

    return {
      data: innerData,
      usage: {
        total_cost_usd: raw.total_cost_usd,
        duration_ms: raw.duration_ms,
        num_turns: raw.num_turns,
      },
      threadId: raw.session_id ?? null,
    };
  }
}
