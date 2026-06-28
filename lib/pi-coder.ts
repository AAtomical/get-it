import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { loadSettings } from "./settings-store";
import { CodexError } from "./codex-errors";
import { resolveBundledBinary } from "./providers/cli-runner";

const execFileAsync = promisify(execFile);

export type RunOptions = {
  signal?: AbortSignal;
};

/** Absolute path to the Pi Coding Agent's `dist/cli.js`. */
function getPiCliPath(): string {
  // resolveBundledBinary("pi") honours PI_BINARY_PATH (wired by the Electron
  // main) and the staged electron/pi-bin/pi-cli copy used in the packaged
  // app and in dev after `electron:prepare`.
  const resolved = resolveBundledBinary("pi");
  if (resolved) return resolved;
  // Source-tree dev fallback: the package as installed in node_modules.
  return path.resolve(
    process.cwd(),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
}

import fs from "node:fs";
import { DATA_DIR } from "./paths";

/**
 * Pi's bundled `undici` calls `node:worker_threads.markAsUncloneable`, which
 * only exists in Node ≥ 22.8. Electron 33 bundles Node 20, and we run Pi
 * through Electron's own node (process.execPath) — so without this it throws
 * "webidl.util.markAsUncloneable is not a function". We --require a tiny shim
 * that defines a no-op before Pi loads undici. No-op is safe: it only skips
 * marking objects uncloneable for structuredClone, which Pi never relies on.
 */
const PI_UNDICI_SHIM = `"use strict";
try {
  const wt = require("node:worker_threads");
  if (typeof wt.markAsUncloneable !== "function") wt.markAsUncloneable = () => {};
} catch {}
`;

function ensurePiShim(): string {
  const shimPath = path.join(DATA_DIR, "pi-undici-shim.cjs");
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(shimPath, PI_UNDICI_SHIM, "utf8");
  } catch {
    /* best-effort */
  }
  return shimPath;
}

/**
 * Pi ships as a pure-JS CLI (like Gemini), so we run its `cli.js` through
 * Electron's own node (process.execPath) rather than a bare `node` binary —
 * the packaged app has no system `node` on PATH. The caller sets
 * ELECTRON_RUN_AS_NODE=1 so Electron executes the script instead of booting
 * a GUI; in plain Node contexts that var is simply ignored. `--require`s the
 * undici shim (above) before the CLI loads.
 */
function getPiExecutionConfig(): { binary: string; preArgs: string[] } {
  return { binary: process.execPath, preArgs: ["--require", ensurePiShim(), getPiCliPath()] };
}

function buildEnvAndProvider(settings: ReturnType<typeof loadSettings>): { env: NodeJS.ProcessEnv; provider: string } {
  const env = { ...process.env };
  let provider = "openai";
  
  // Configure Pi to use the provided BYOK settings via a dynamic models.json config
  if (settings.piUrl) {
    const agentDir = path.join(DATA_DIR, "pi-agent");
    fs.mkdirSync(agentDir, { recursive: true });
    
    provider = "getit_byok";
    const apiType = settings.piApiType || "openai-completions";
    
    // Set appropriate API Key in environment variables based on API Protocol
    if (settings.piApiKey) {
      if (apiType === "google-generative-ai") {
        env.GEMINI_API_KEY = settings.piApiKey;
      } else if (apiType === "anthropic-messages") {
        env.ANTHROPIC_API_KEY = settings.piApiKey;
      } else {
        env.OPENAI_API_KEY = settings.piApiKey;
      }
    }

    const modelsJson = {
      providers: {
        getit_byok: {
          baseUrl: settings.piUrl,
          api: apiType,
          apiKey: settings.piApiKey || "dummy",
          models: [
            { id: settings.piModelFast || "llama3.2", reasoning: true },
            { id: settings.piModelSmart || "llama3.2", reasoning: true }
          ]
        }
      }
    };
    fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(modelsJson, null, 2));
    env.PI_CODING_AGENT_DIR = agentDir;
  } else if (settings.piApiKey) {
    env.OPENAI_API_KEY = settings.piApiKey;
  }
  
  // Set offline/telemetry rules for hermetic execution
  env.PI_OFFLINE = "1";
  env.PI_TELEMETRY = "0";

  // We launch cli.js through Electron's node (process.execPath); this makes
  // Electron run the script instead of opening a window. Harmless under
  // plain Node (dev/tests), where the variable is ignored.
  env.ELECTRON_RUN_AS_NODE = "1";

  return { env, provider };
}

/** Strip markdown code fences the model sometimes wraps JSON in, then parse. */
function parseTurnJson<T>(finalResponse: string | undefined): T {
  let text = finalResponse?.trim();
  if (!text) throw new Error("Empty finalResponse from pi");

  // Strip thought/thinking blocks first
  text = text
    .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(cleaned) as T;
}

type PiContentBlock = { type?: string; text?: string };
type PiMessage = {
  role?: string;
  content?: PiContentBlock[];
  usage?: unknown;
  errorMessage?: string;
};
type PiEvent = {
  type?: string;
  errorMessage?: string;
  message?: PiMessage;
  messages?: PiMessage[];
};

function parsePiNdjson<T>(stdout: string): { data: T; usage: unknown } {
  const lines = stdout.split('\n').filter(l => l.trim().length > 0);
  let assistantText = "";
  let usage: unknown = null;
  let errorMessage = "";

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as PiEvent;
      if (event.errorMessage) {
        errorMessage = event.errorMessage;
      }
      if (event.message?.errorMessage) {
        errorMessage = event.message.errorMessage;
      }

      if (event.type === "agent_end" && event.messages) {
         const lastMsg = event.messages[event.messages.length - 1];
         if (lastMsg?.role === "assistant") {
            const textContent = lastMsg.content?.find((c) => c.type === "text")?.text;
            if (textContent) assistantText = textContent;
            if (lastMsg.usage) usage = lastMsg.usage;
         }
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
         const textContent = event.message.content?.find((c) => c.type === "text")?.text;
         if (textContent) assistantText = textContent;
         if (event.message.usage) usage = event.message.usage;
      }
    } catch {
      // ignore non-json lines
    }
  }

  if (errorMessage && !assistantText) {
     throw new Error(errorMessage);
  }

  if (!assistantText) {
    // Fallback if the output wasn't NDJSON
    return { data: parseTurnJson<T>(stdout), usage: null };
  }

  return { data: parseTurnJson<T>(assistantText), usage };
}

function logPiProcess(proc: ChildProcess | null, label: string) {
  if (!proc) return;
  const startTime = Date.now();
  let firstTokenTime: number | null = null;

  console.log(`\x1b[35m[Pi Telemetry] [${label}] Starting child process...\x1b[0m`);

  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    const lines = text.split("\n").filter((l: string) => l.trim().length > 0);

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as PiEvent & { content_block_delta?: unknown };
        
        // Log basic events
        if (event.type) {
          console.log(`\x1b[36m[Pi Event] [${label}] ${event.type}\x1b[0m`);
        }
        
        // Track first token / time to first token
        if (event.type === "content_block_delta" || (event.message?.content && event.type !== "message_end")) {
          if (firstTokenTime === null) {
            firstTokenTime = Date.now();
            const ttft = firstTokenTime - startTime;
            console.log(`\x1b[32m[Pi Telemetry] [${label}] Time to First Token (TTFT): ${ttft}ms\x1b[0m`);
          }
        }
        
        // If there's an error message in the event
        if (event.errorMessage || event.message?.errorMessage) {
          console.error(`\x1b[31m[Pi Coder ERROR] [${label}] ${event.errorMessage || event.message?.errorMessage}\x1b[0m`);
        }
        
      } catch {
        // Not JSON, log as raw text
        console.log(`[Pi Raw stdout] [${label}] ${line}`);
      }
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    const lines = text.split("\n").filter((l: string) => l.trim().length > 0);
    for (const line of lines) {
      console.error(`\x1b[33m[Pi stderr] [${label}] ${line}\x1b[0m`);
    }
  });

  proc.on("close", (code: number) => {
    const duration = Date.now() - startTime;
    console.log(`\x1b[35m[Pi Telemetry] [${label}] Process exited with code ${code}. Total duration: ${duration}ms\x1b[0m`);
  });
}

export async function runJsonPi<T>(
  prompt: string,
  outputSchema: object,
  opts: RunOptions = {},
): Promise<{ data: T; usage: unknown }> {
  const settings = loadSettings();
  const model = settings.piModelFast || "llama3.2";
  const { binary, preArgs } = getPiExecutionConfig();
  const { env, provider } = buildEnvAndProvider(settings);

  // Instruct the model to return JSON matching the schema
  const augmentedPrompt = `${prompt}\n\nYou MUST respond ONLY in valid JSON that matches the following schema:\n${JSON.stringify(outputSchema, null, 2)}`;

  // Prompt goes over STDIN (not as a `--print <arg>`): a full-document prompt
  // would otherwise exceed the OS command-line limit (E2BIG → spawn failure).
  const args = [
    ...preArgs,
    "--mode", "json",
    "--print",
    "--provider", provider,
    "--model", model,
    "--no-tools" // Hermetic execution, no side effects
  ];

  console.log(`\x1b[34m[Pi Command] Running: ${binary} ${args.join(" ")}\x1b[0m`);

  try {
    const proc = execFileAsync(binary, args, {
      env,
      signal: opts.signal,
      maxBuffer: 10 * 1024 * 1024,
    });

    logPiProcess(proc.child, "runJsonPi");

    proc.child.stdin?.write(augmentedPrompt);
    proc.child.stdin?.end();
    const { stdout } = await proc;
    const parsed = parsePiNdjson<T>(stdout);
    return { data: parsed.data, usage: parsed.usage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CodexError("generic", `Pi CLI runJson failed: ${message}`);
  }
}

export async function runJsonInThreadPi<T>(args: {
  outputSchema: object;
  opts?: RunOptions;
  resume?: { threadId: string; input: string };
  start?: { input: string };
}): Promise<{ data: T; usage: unknown; threadId: string | null }> {
  const settings = loadSettings();
  const model = settings.piModelSmart || "llama3.2";
  const { binary, preArgs } = getPiExecutionConfig();
  const { env, provider } = buildEnvAndProvider(settings);

  let prompt = "";
  let threadId = args.resume?.threadId;

  if (args.start) {
    prompt = `${args.start.input}\n\nYou MUST respond ONLY in valid JSON that matches the following schema:\n${JSON.stringify(args.outputSchema, null, 2)}`;
  } else if (args.resume) {
    prompt = `${args.resume.input}\n\nYou MUST respond ONLY in valid JSON that matches the following schema:\n${JSON.stringify(args.outputSchema, null, 2)}`;
  } else {
    throw new Error("runJsonInThreadPi: provide `start` or `resume`");
  }

  // Prompt over STDIN (not `--print <arg>`) to avoid the command-line limit.
  const cliArgs = [
    ...preArgs,
    "--mode", "json",
    "--print",
    "--provider", provider,
    "--model", model,
    "--no-tools"
  ];

  // If resuming, pass the session flag
  if (threadId) {
    cliArgs.push("--session", threadId);
  } else {
    // We need a unique session id so we can resume it later
    threadId = `pi-session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    cliArgs.push("--session-id", threadId);
  }

  console.log(`\x1b[34m[Pi Command] Running: ${binary} ${cliArgs.join(" ")}\x1b[0m`);

  try {
    const proc = execFileAsync(binary, cliArgs, {
      env,
      signal: args.opts?.signal,
      maxBuffer: 10 * 1024 * 1024,
    });

    logPiProcess(proc.child, "runJsonInThreadPi");

    proc.child.stdin?.write(prompt);
    proc.child.stdin?.end();
    const { stdout } = await proc;
    const parsed = parsePiNdjson<T>(stdout);
    return { data: parsed.data, usage: parsed.usage, threadId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CodexError("generic", `Pi CLI runJsonInThread failed: ${message}`);
  }
}
