/**
 * Gemini CLI provider — invokes `gemini` as a subprocess.
 *
 * CLI invocation:
 *   gemini -p "<prompt>" --output-format json --model gemini-2.5-pro
 *
 * JSON output shape:
 *   { response: string, stats: { prompt_token_count, candidates_token_count, total_token_count, latency_ms } }
 *
 * Thread support:
 *   Uses native --resume <session-id> for session continuation.
 */

import fs from "node:fs";
import path from "node:path";
import { CODEX_SCRATCH_DIR } from "../paths";
import type {
  AIProvider,
  RunOptions,
  RunJsonResult,
  RunJsonInThreadResult,
} from "../provider-types";
import { whichBinary, runCliBinary, parseJsonResponse, resolveBundledBinary } from "./cli-runner";
import { loadSettings } from "../settings-store";

const GEMINI_TIMEOUT_MS = 600_000;

function ensureGeminiProjectSettings(model: string): void {
  try {
    const dir = path.join(CODEX_SCRATCH_DIR, ".gemini");
    const file = path.join(dir, "settings.json");
    const desired = {
      modelConfigs: {
        overrides: [
          {
            match: { model },
            modelConfig: {
              generateContentConfig: {
                maxOutputTokens: 65536,
              },
            },
          },
        ],
      },
    };
    const json = JSON.stringify(desired, null, 2);
    let current: string | null = null;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      current = null;
    }
    if (current !== json) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, json, "utf8");
    }
  } catch {
    /* best-effort */
  }
}

type GeminiJsonOutput = {
  response: string;
  stats?: {
    prompt_token_count?: number;
    candidates_token_count?: number;
    total_token_count?: number;
    latency_ms?: number;
  };
};

function parseGeminiResult<T>(stdout: string): { data: T; usage: GeminiJsonOutput["stats"] | null } {
  const raw = parseJsonResponse<GeminiJsonOutput>(stdout);
  if (!raw.response || !raw.response.trim()) {
    throw new Error(
      "Gemini returned an empty response (the model's output was likely truncated before any answer was produced).",
    );
  }
  return { data: parseJsonResponse<T>(raw.response), usage: raw.stats ?? null };
}

let _binaryPath: string | null | undefined;

function resolveBinary(): string {
  if (_binaryPath === undefined) {
    _binaryPath = resolveBundledBinary("gemini") || whichBinary("gemini");
  }
  if (!_binaryPath) {
    throw new Error(
      "Gemini CLI not found.",
    );
  }
  return _binaryPath;
}

/** Reset the cached binary path (e.g. after install). */
export function resetGeminiBinaryCache(): void {
  _binaryPath = undefined;
}

export class GeminiProvider implements AIProvider {
  readonly name = "gemini" as const;

  async runJson<T>(
    prompt: string,
    outputSchema: object,
    opts: RunOptions = {},
  ): Promise<RunJsonResult<T>> {
    const bin = resolveBinary();

    // Build the full prompt with schema instructions
    const fullPrompt = buildPromptWithSchema(prompt, outputSchema);

    const settings = loadSettings();
    const reasoning = opts.reasoning ?? "low";
    const model = reasoning === "low" 
      ? (settings.geminiModelFast || "gemini-flash-lite-latest") 
      : (settings.geminiModelSmart || "gemini-pro-latest");
    ensureGeminiProjectSettings(model);

    const args = [
      "--skip-trust",
      "--output-format",
      "json",
      "--model",
      model,
    ];

    const result = await runCliBinary(bin, args, {
      signal: opts.signal,
      stdin: fullPrompt,
      cwd: CODEX_SCRATCH_DIR,
      timeoutMs: GEMINI_TIMEOUT_MS,
      env: settings.geminiApiKey ? { GEMINI_API_KEY: settings.geminiApiKey } : undefined,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr || result.stdout || `Gemini CLI exited with code ${result.exitCode}`,
      );
    }

    const { data: innerData, usage } = parseGeminiResult<T>(result.stdout);

    return {
      data: innerData,
      usage,
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
      // Use --resume <session-id> for thread continuation
      const fullPrompt = buildPromptWithSchema(
        args.resume.input,
        args.outputSchema,
      );
      const settings = loadSettings();
      const reasoning = opts.reasoning ?? "low";
      const model = reasoning === "low" 
        ? (settings.geminiModelFast || "gemini-flash-lite-latest") 
        : (settings.geminiModelSmart || "gemini-pro-latest");
      ensureGeminiProjectSettings(model);

      const cliArgs = [
        "--skip-trust",
        "--resume",
        args.resume.threadId,
        "--output-format",
        "json",
        "--model",
        model,
      ];

      const result = await runCliBinary(bin, cliArgs, {
        signal: opts.signal,
        stdin: fullPrompt,
        cwd: CODEX_SCRATCH_DIR,
        timeoutMs: GEMINI_TIMEOUT_MS,
        env: settings.geminiApiKey ? { GEMINI_API_KEY: settings.geminiApiKey } : undefined,
      });

      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr ||
            result.stdout ||
            `Gemini CLI resume exited with code ${result.exitCode}`,
        );
      }

      const { data: innerData, usage } = parseGeminiResult<T>(result.stdout);

      return {
        data: innerData,
        usage,
        // Gemini doesn't return a new session ID on resume — keep the same one
        threadId: args.resume.threadId,
      };
    }

    if (!args.start)
      throw new Error("runJsonInThread: provide `start` or `resume`");

    const fullPrompt = buildPromptWithSchema(
      args.start.input,
      args.outputSchema,
    );
    const settings = loadSettings();
    const reasoning = opts.reasoning ?? "low";
    const model = reasoning === "low" 
      ? (settings.geminiModelFast || "gemini-flash-lite-latest") 
      : (settings.geminiModelSmart || "gemini-pro-latest");
    ensureGeminiProjectSettings(model);

    const cliArgs = [
      "--skip-trust",
      "--output-format",
      "json",
      "--model",
      model,
    ];

    const result = await runCliBinary(bin, cliArgs, {
      signal: opts.signal,
      stdin: fullPrompt,
      cwd: CODEX_SCRATCH_DIR,
      timeoutMs: GEMINI_TIMEOUT_MS,
      env: settings.geminiApiKey ? { GEMINI_API_KEY: settings.geminiApiKey } : undefined,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr ||
          result.stdout ||
          `Gemini CLI exited with code ${result.exitCode}`,
      );
    }

    const { data: innerData, usage } = parseGeminiResult<T>(result.stdout);

    // Gemini CLI doesn't expose a session_id in JSON output — use null
    // (the caller will fall back to start with full context on next turn)
    return {
      data: innerData,
      usage,
      threadId: null,
    };
  }
}

/**
 * Build a prompt that instructs the model to return JSON matching the schema.
 * Gemini CLI doesn't support --json-schema, so we embed the schema in the prompt.
 */
function buildPromptWithSchema(prompt: string, outputSchema: object): string {
  return `${prompt}

IMPORTANT: You MUST respond with valid JSON only — no markdown fences, no prose.
The JSON MUST conform to this schema:
${JSON.stringify(outputSchema, null, 2)}`;
}
