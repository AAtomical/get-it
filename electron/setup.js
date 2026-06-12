/**
 * Get It. — Codex CLI setup module.
 *
 * Detects, installs/updates, and authenticates the Codex CLI before the
 * Next.js server starts — and again any time the renderer reports that a
 * Codex call has failed with auth_lost / binary_missing.
 *
 * Design notes:
 *
 *  • The Codex binary ships *inside* node_modules via the @openai/codex
 *    npm package (a thin wrapper) + a platform-specific optionalDep that
 *    contains the actual Rust binary. So "installing Codex" in our case
 *    really means "make sure @openai/codex-<platform>-<arch> is present
 *    on disk". We never touch system PATH.
 *
 *  • We resolve the binary by walking node_modules ourselves (we don't
 *    rely on the SDK's lookup because we want to know whether the file
 *    exists *before* we spawn the server). The vendor layout is exactly
 *    what codex-sdk uses: vendor/<target-triple>/codex/codex(.exe).
 *
 *  • For OAuth login we spawn `codex login` and parse its stdout. The
 *    binary itself opens the browser via the `webbrowser` crate; if that
 *    fails we also surface the URL in the wizard window. Success is the
 *    literal line "Successfully logged in", failure is a non-zero exit.
 *
 *  • The wizard is its own BrowserWindow loading electron/wizard/*.html
 *    — file:// works fine here, it's a stand-alone static page. The
 *    main app window only opens after the wizard resolves successfully.
 */

"use strict";

const { BrowserWindow, ipcMain, shell, app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const https = require("node:https");
const os = require("node:os");
const zlib = require("node:zlib");

const REQUIRED_CODEX_VERSION = "0.130.0";

// ── Platform target triple (same table as @openai/codex-sdk) ────────────
const PLATFORM_PACKAGE_BY_TARGET = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

const CLAUDE_PKG_BY_TARGET = {
  "x86_64-unknown-linux-musl": "@anthropic-ai/claude-code-linux-x64",
  "aarch64-unknown-linux-musl": "@anthropic-ai/claude-code-linux-arm64",
  "x86_64-apple-darwin": "@anthropic-ai/claude-code-darwin-x64",
  "aarch64-apple-darwin": "@anthropic-ai/claude-code-darwin-arm64",
  "x86_64-pc-windows-msvc": "@anthropic-ai/claude-code-win32-x64",
  "aarch64-pc-windows-msvc": "@anthropic-ai/claude-code-win32-arm64",
};

function targetTriple() {
  const { platform, arch } = process;
  if (platform === "linux" || platform === "android") {
    if (arch === "x64") return "x86_64-unknown-linux-musl";
    if (arch === "arm64") return "aarch64-unknown-linux-musl";
  } else if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
  } else if (platform === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
  }
  return null;
}

function platformPackage() {
  const t = targetTriple();
  return t ? PLATFORM_PACKAGE_BY_TARGET[t] : null;
}

// ── Search roots: bundled (production) first, then host node_modules ────
function candidateNodeModulesRoots() {
  const roots = new Set();
  const add = (p) => p && roots.add(p);
  if (process.resourcesPath) {
    // electron-builder asarUnpack target
    add(path.join(process.resourcesPath, "app.asar.unpacked", "node_modules"));
    // electron-builder extraResources fallback
    add(path.join(process.resourcesPath, "node_modules"));
  }
  add(path.join(app.getAppPath(), "node_modules"));
  add(path.join(app.getAppPath(), ".next", "standalone", "node_modules"));
  return [...roots];
}

/**
 * The packaged app stages exactly one platform binary at
 * `electron/codex-bin/<triple>/codex/codex(.exe)` — this is the path that
 * extraResources lands at runtime. We try it first; then fall back to
 * the node_modules layout (useful in dev and as a recovery path).
 */
function bundledStagedBinaryPaths() {
  const triple = targetTriple();
  if (!triple) return [];
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const out = [];
  if (process.resourcesPath) {
    out.push(
      path.join(process.resourcesPath, "app.asar.unpacked", "electron", "codex-bin", triple, "codex", exe),
      path.join(process.resourcesPath, "electron", "codex-bin", triple, "codex", exe),
    );
  }
  out.push(path.join(app.getAppPath(), "electron", "codex-bin", triple, "codex", exe));
  return out;
}

function maybeChmod(p) {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(p, 0o755);
  } catch {
    /* ignore */
  }
}

/**
 * Locate the Codex CLI binary. Returns `{ path, source }` or null.
 *
 *   source: "bundled" → electron/codex-bin/<triple>/codex/codex(.exe).
 *           This is the canonical copy — electron-prepare.mjs stages it
 *           at build time AND in dev (when `npm run electron:prepare`
 *           runs from `npm run dev`). It's what we ship to every user.
 *
 *   source: "node_modules" → a last-resort dev fallback when someone
 *           runs raw `electron .` without `electron:prepare` and happens
 *           to have @openai/codex-<triple> as a transitive dep in
 *           node_modules. Production builds never hit this.
 *
 *   source: "userdata" → the wizard-downloaded copy in
 *           <userData>/codex-bundle/. The wizard only writes here when
 *           the bundled copy is missing (corrupted install, antivirus
 *           quarantine — the only realistic edge cases on Windows).
 *
 * The bundled copy always wins. We never look at $PATH, npm global, or
 * any system-wide Codex install: behaviour must be identical for every
 * user, regardless of whether they happen to be a developer.
 */
function resolveCodexBinary() {
  const triple = targetTriple();
  if (!triple) return null;
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  for (const candidate of bundledStagedBinaryPaths()) {
    if (fs.existsSync(candidate)) {
      maybeChmod(candidate);
      return { path: candidate, source: "bundled" };
    }
  }
  const pkg = platformPackage();
  if (pkg) {
    for (const root of candidateNodeModulesRoots()) {
      const candidate = path.join(root, pkg, "vendor", triple, "codex", exe);
      if (fs.existsSync(candidate)) {
        maybeChmod(candidate);
        return { path: candidate, source: "node_modules" };
      }
    }
  }
  const userDataBin = bundledCodexPath();
  if (userDataBin && fs.existsSync(userDataBin)) {
    return { path: userDataBin, source: "userdata" };
  }
  return null;
}

function resolveBundledBinary(provider) {
  const triple = targetTriple();
  const isWin = process.platform === "win32";

  const getSubPath = () => {
    if (provider === "claude") {
      return triple ? ["claude-bin", triple, "claude", isWin ? "claude.exe" : "claude"] : null;
    }
    return ["gemini-bin", "gemini-cli", "bundle", "gemini.js"];
  };

  const subPath = getSubPath();
  if (!subPath) return null;

  const out = [];
  if (process.resourcesPath) {
    out.push(
      path.join(process.resourcesPath, "app.asar.unpacked", "electron", ...subPath),
      path.join(process.resourcesPath, "electron", ...subPath)
    );
  }
  out.push(path.join(app.getAppPath(), "electron", ...subPath));

  for (const candidate of out) {
    if (fs.existsSync(candidate)) {
      maybeChmod(candidate);
      return candidate;
    }
  }

  if (provider === "claude") {
    const pkg = triple ? CLAUDE_PKG_BY_TARGET[triple] : null;
    if (pkg) {
      for (const root of candidateNodeModulesRoots()) {
        const candidate = path.join(root, pkg, isWin ? "claude.exe" : "claude");
        if (fs.existsSync(candidate)) {
          maybeChmod(candidate);
          return candidate;
        }
      }
    }
  } else if (provider === "gemini") {
    for (const root of candidateNodeModulesRoots()) {
      const candidate = path.join(root, "@google", "gemini-cli", "bundle", "gemini.js");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function getCodexVersion(binPath) {
  if (!binPath) return null;
  try {
    const r = spawnSync(binPath, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (r.status !== 0) return null;
    const out = (r.stdout || "").trim();
    const m = /(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)/i.exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function semverGte(a, b) {
  if (!a || !b) return false;
  const pa = a.split(/[-+]/)[0].split(".").map(Number);
  const pb = b.split(/[-+]/)[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

function isCodexAuthenticated(binPath) {
  if (!binPath) return false;
  try {
    const r = spawnSync(binPath, ["login", "status"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (r.status !== 0) return false;
    const out = (r.stdout || "") + (r.stderr || "");
    return /Logged in/i.test(out);
  } catch {
    return false;
  }
}

// ── Bundled binary fetch (when missing) ─────────────────────────────────
// In the packaged app the codex binary should always be present, but if
// it isn't (corrupted install, antivirus quarantine, etc.) we offer to
// download it from npm and drop it into a writable spot under userData.
const NPM_REGISTRY = "https://registry.npmjs.org";

function userDataBundleRoot() {
  const root = path.join(app.getPath("userData"), "codex-bundle");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function bundledCodexPath() {
  const triple = targetTriple();
  if (!triple) return null;
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  return path.join(userDataBundleRoot(), "vendor", triple, "codex", exe);
}

function downloadToBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          downloadToBuffer(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function fetchCodexBinaryToUserData(version, onProgress) {
  const triple = targetTriple();
  if (!triple) throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
  // The platform package on npm has a versioned aliased name:
  //   "@openai/codex" with versions "0.130.0-darwin-arm64" etc.
  // We download its tarball directly.
  const suffix = (() => {
    if (triple === "x86_64-unknown-linux-musl") return "linux-x64";
    if (triple === "aarch64-unknown-linux-musl") return "linux-arm64";
    if (triple === "x86_64-apple-darwin") return "darwin-x64";
    if (triple === "aarch64-apple-darwin") return "darwin-arm64";
    if (triple === "x86_64-pc-windows-msvc") return "win32-x64";
    if (triple === "aarch64-pc-windows-msvc") return "win32-arm64";
    throw new Error("Unsupported target");
  })();
  const tarballUrl = `${NPM_REGISTRY}/@openai/codex/-/codex-${version}-${suffix}.tgz`;
  onProgress?.({ phase: "download", note: tarballUrl });
  const gzBuf = await downloadToBuffer(tarballUrl);
  const tarBuf = zlib.gunzipSync(gzBuf);
  onProgress?.({ phase: "extract" });
  // Parse the tar buffer manually (POSIX USTAR format). We only need the
  // vendor/<triple>/codex/codex(.exe) and any sibling files. Streaming
  // tar parsers exist but adding a dep just for one tarball isn't worth it.
  await extractTarBuffer(tarBuf, userDataBundleRoot());
  const out = bundledCodexPath();
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(out, 0o755);
    } catch {
      /* ignore */
    }
  }
  if (!fs.existsSync(out)) {
    throw new Error(`Codex binary not found at ${out} after extraction`);
  }
  return out;
}

function extractTarBuffer(buf, destRoot) {
  // POSIX ustar tar: 512-byte header + content padded to 512.
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) {
      offset += 512;
      continue;
    }
    let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeStr = header.subarray(124, 124 + 12).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr || "0", 8);
    const typeFlag = String.fromCharCode(header[156] || 0);
    const prefix = header.subarray(345, 345 + 155).toString("utf8").replace(/\0.*$/, "");
    if (prefix) name = `${prefix}/${name}`;
    // npm tarballs nest contents under "package/". Strip it.
    name = name.replace(/^package\//, "");
    const start = offset + 512;
    const end = start + size;
    if (typeFlag === "0" || typeFlag === "" || typeFlag === "\0") {
      const fileBuf = buf.subarray(start, end);
      const outPath = path.join(destRoot, name);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, fileBuf);
    } else if (typeFlag === "5") {
      fs.mkdirSync(path.join(destRoot, name), { recursive: true });
    }
    offset = end + (512 - (size % 512)) % 512;
  }
  return Promise.resolve();
}

// ── Wizard window ───────────────────────────────────────────────────────
// We talk to it over IPC. Loading wizard.html via file:// is the simplest
// path; nothing in the wizard needs a server.
let wizardWindow = null;
let wizardResolvers = []; // queue of {resolve, reject} for current showSetupWindow calls

function ensureIpcHandlers() {
  if (ensureIpcHandlers._wired) return;
  ensureIpcHandlers._wired = true;

  ipcMain.handle("wizard:status", () => refreshCodexStatus());
  ipcMain.handle("wizard:install", async () => {
    const status = refreshCodexStatus();
    if (status.binaryFound && semverGte(status.version, REQUIRED_CODEX_VERSION)) {
      sendStatus();
      return refreshCodexStatus();
    }
    try {
      sendStatus({ phase: "installing", message: "Downloading Codex CLI…" });
      await fetchCodexBinaryToUserData(REQUIRED_CODEX_VERSION, (p) => {
        sendStatus({ phase: "installing", message: p.phase === "download" ? "Downloading Codex CLI…" : "Unpacking Codex CLI…" });
      });
      sendStatus({ phase: "idle" });
    } catch (err) {
      sendStatus({ phase: "error", message: String(err && err.message ? err.message : err) });
      return refreshCodexStatus();
    }
    return refreshCodexStatus();
  });
  ipcMain.handle("wizard:login", async (_e, provider) => {
    if (provider === "claude") {
      const { exec } = require('child_process');
      const cmd = process.platform === "win32" 
        ? 'start cmd.exe /c "npx -y @anthropic-ai/claude-code auth login & pause"' 
        : process.platform === "darwin" 
        ? `osascript -e 'tell app "Terminal" to do script "npx -y @anthropic-ai/claude-code auth login"'` 
        : `x-terminal-emulator -e 'npx -y @anthropic-ai/claude-code auth login' || gnome-terminal -- npx -y @anthropic-ai/claude-code auth login || xterm -e 'npx -y @anthropic-ai/claude-code auth login'`;
      exec(cmd);
      return;
    }
    sendStatus({ phase: "logging-in", message: "Waiting for browser login…" });
    try {
      const ok = await runCodexLogin((line) => {
        // expose the auth URL if the binary prints one
        const m = /(https?:\/\/[^\s]+auth[^\s]*)/i.exec(line);
        if (m) {
          sendStatus({ phase: "logging-in", message: "Waiting for browser login…", authUrl: m[1] });
        }
      });
      sendStatus({ phase: ok ? "idle" : "error", message: ok ? undefined : "Login did not complete." });
    } catch (err) {
      sendStatus({ phase: "error", message: String(err && err.message ? err.message : err) });
    }
    return refreshCodexStatus();
  });
  ipcMain.handle("wizard:open-url", async (_e, url) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) {
      await shell.openExternal(url).catch(() => {});
    }
  });
  ipcMain.handle("wizard:finish", (_e, payload) => {
    const override = payload && payload.provider;
    if (override && override !== "codex") {
      try {
        const settingsPath = path.join(app.getPath("userData"), "settings.json");
        let settings = { v: 2, autoGenerate: false, maxRetries: 3 };
        if (fs.existsSync(settingsPath)) {
          try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
        }
        settings.provider = override;
        if (override !== "pi") {
          settings.managedProvider = override;
        }
        if (override === "gemini" && payload.geminiApiKey) {
          settings.geminiApiKey = payload.geminiApiKey;
          process.env.GEMINI_API_KEY = payload.geminiApiKey;
        }
        fs.writeFileSync(settingsPath, JSON.stringify(settings));
      } catch (err) {}
      closeWizardWindow(true);
      return refreshCodexStatus();
    }

    const status = refreshCodexStatus();
    if (status.binaryFound && status.versionOk && status.loggedIn) {
      closeWizardWindow(true);
    }
    return status;
  });
  ipcMain.handle("wizard:cancel", () => {
    closeWizardWindow(false);
  });
}

function closeWizardWindow(resolved) {
  const w = wizardWindow;
  wizardWindow = null;
  for (const r of wizardResolvers) {
    if (resolved) r.resolve(true);
    else r.resolve(false);
  }
  wizardResolvers = [];
  if (w && !w.isDestroyed()) w.close();
}

function sendStatus(extra) {
  if (!wizardWindow || wizardWindow.isDestroyed()) return;
  const base = refreshCodexStatus();
  const merged = { ...base, ...(extra || {}) };
  wizardWindow.webContents.send("wizard-status", merged);
}

async function showSetupWindow(opts = {}) {
  ensureIpcHandlers();
  if (wizardWindow) {
    wizardWindow.focus();
    return new Promise((resolve, reject) => {
      wizardResolvers.push({ resolve, reject });
    });
  }
  wizardWindow = new BrowserWindow({
    width: 560,
    height: 600,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Get It. — Setup",
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload-wizard.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  wizardWindow.removeMenu?.();
  wizardWindow.loadFile(path.join(__dirname, "wizard", "index.html"), {
    query: { reason: opts.reason || "first-run" },
  });
  wizardWindow.once("ready-to-show", () => {
    wizardWindow?.show();
    sendStatus();
  });
  wizardWindow.on("closed", () => {
    const w = wizardWindow;
    wizardWindow = null;
    // If the user x-ed out without finishing, treat as cancel.
    for (const r of wizardResolvers) r.resolve(false);
    wizardResolvers = [];
    void w; // silence lint
  });
  return new Promise((resolve, reject) => {
    wizardResolvers.push({ resolve, reject });
  });
}

// Windows NT status codes we recognise from a non-zero codex.exe exit.
// uv reports the raw NTSTATUS as an unsigned 32-bit integer; map the
// ones that come back with a useful answer for the user.
const WIN_EXIT_HINTS = {
  // 0xC0000005 — STATUS_ACCESS_VIOLATION. The Rust binary crashed
  // dereferencing an invalid pointer at (or near) startup. The single
  // most common cause on a clean Windows VM / minimal install is the
  // Microsoft Visual C++ Redistributable not being present: codex.exe
  // is dynamically linked against VCRUNTIME140.dll / MSVCP140.dll and
  // without those the OS loader leaves imports NULL.
  3221225781:
    "Codex CLI crashed at startup with a Windows access violation (0xC0000005). " +
    "This almost always means the Microsoft Visual C++ Redistributable is missing on this machine. " +
    "Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe, restart, and try again.",
  // 0xC000007B — STATUS_INVALID_IMAGE_FORMAT. The .exe is the wrong
  // architecture for this CPU (or a dependent DLL is the wrong arch).
  3221225595:
    "Codex CLI cannot start: 0xC000007B (invalid image format). The binary architecture " +
    "doesn't match this CPU. Common on Apple Silicon VMs that haven't enabled x86_64 " +
    "translation, or on older 32-bit Windows.",
  // 0xC0000135 — STATUS_DLL_NOT_FOUND. A required DLL is missing.
  3221225477:
    "Codex CLI cannot start: a required DLL is missing (0xC0000135). " +
    "Install the Microsoft Visual C++ Redistributable from " +
    "https://aka.ms/vs/17/release/vc_redist.x64.exe and try again.",
};

function explainCodexExitOnWindows(code, tail) {
  if (process.platform !== "win32") return null;
  if (typeof code !== "number") return null;
  return WIN_EXIT_HINTS[code] || null;
}

// ── codex login subprocess driver ───────────────────────────────────────
function runCodexLogin(onLine) {
  return new Promise((resolve, reject) => {
    const resolved = resolveCodexBinary();
    if (!resolved) {
      reject(new Error("Codex binary not available"));
      return;
    }
    const child = spawn(resolved.path, ["login"], {
      // Pipe (not ignore) for stdin: some Rust console binaries crash
      // on Windows when stdin is set to a null handle rather than a
      // real pipe. We don't write anything, but the open pipe gives
      // codex.exe a valid GetStdHandle(STD_INPUT_HANDLE).
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    let stdoutBuf = "";
    let succeeded = false;
    const onChunk = (data) => {
      const text = data.toString("utf8");
      stdoutBuf += text;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        onLine?.(line);
        if (/Successfully logged in/i.test(line)) {
          succeeded = true;
        }
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.once("exit", (code) => {
      if (succeeded || code === 0) {
        resolve(true);
      } else {
        const tail = stdoutBuf.split(/\r?\n/).slice(-3).join("\n").trim();
        const hint = explainCodexExitOnWindows(code, tail);
        reject(
          new Error(
            hint || tail || `codex login exited with code ${code}`,
          ),
        );
      }
    });
    child.once("error", reject);
  });
}

// ── Status snapshot + subscribers ───────────────────────────────────────
const statusSubscribers = new Set();

function refreshCodexStatus() {
  const resolved = resolveCodexBinary();
  const bin = resolved ? resolved.path : null;
  const source = resolved ? resolved.source : null;
  // The bundled copy IS the version we declared as required — we shipped
  // that exact file from electron-prepare.mjs at build time. Spawning
  // `codex --version` just to read the same number back is wasted work
  // and, worse, races against Windows Defender's first-launch scan of
  // the 235 MB codex.exe: the scan routinely pushes spawnSync past its
  // 5-second timeout, returns null, and the wizard renders "Codex CLI ?"
  // with a useless Update button that re-downloads the same binary into
  // userData. Trust the build-pinned version for bundled; spawn only for
  // the userdata fallback and the dev node_modules path, where the
  // version is genuinely unknown to us.
  const version = source === "bundled"
    ? (bin ? REQUIRED_CODEX_VERSION : null)
    : (bin ? getCodexVersion(bin) : null);
  const versionOk = version ? semverGte(version, REQUIRED_CODEX_VERSION) : false;
  const loggedIn = bin && versionOk ? isCodexAuthenticated(bin) : false;
  const status = {
    binaryFound: !!bin,
    binaryPath: bin,
    binarySource: source,
    version,
    requiredVersion: REQUIRED_CODEX_VERSION,
    versionOk,
    loggedIn,
    targetTriple: targetTriple(),
  };
  for (const cb of statusSubscribers) {
    try {
      cb(status);
    } catch {
      /* ignore */
    }
  }
  return status;
}

function onCodexStatusChange(cb) {
  statusSubscribers.add(cb);
  return () => statusSubscribers.delete(cb);
}

// ── Public: run before main window opens ────────────────────────────────

/**
 * Read the saved provider from settings.json.
 * Falls back to "codex" if the file is missing or malformed.
 */
function readSavedProvider() {
  try {
    const settingsPath = path.join(app.getPath("userData"), "settings.json");
    if (!fs.existsSync(settingsPath)) return "codex";
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    if (raw.provider === "gemini" || raw.provider === "claude" || raw.provider === "pi") return raw.provider;
    return "codex";
  } catch {
    return "codex";
  }
}

/**
 * Resolve a CLI binary on $PATH with augmented search paths.
 * Returns the absolute path or null.
 */
function resolveCliOnPath(binaryName) {
  const cmd = process.platform === "win32" ? "where.exe" : "which";
  const home = os.homedir();
  const extraPaths = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    `${home}/.npm-global/bin`,
    `${home}/.nvm/current/bin`,
    `${home}/.local/bin`,
  ];
  const basePath = process.env.PATH || "";
  const existing = new Set(basePath.split(":"));
  const additions = extraPaths.filter((p) => !existing.has(p));
  const augmented = additions.length ? `${basePath}:${additions.join(":")}` : basePath;

  try {
    const r = spawnSync(cmd, [binaryName], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: augmented },
    });
    if (r.status !== 0) return null;
    const line = (r.stdout || "").trim().split(/\r?\n/)[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}



/**
 * Check if a CLI binary is authenticated.
 */
function isCliAuthenticated(binaryPath, provider) {
  if (provider === "claude") {
    try {
      const isJs = binaryPath.endsWith(".js");
      const bin = isJs ? process.execPath : binaryPath;
      const args = isJs ? [binaryPath, "auth", "status"] : ["auth", "status"];
      const r = spawnSync(bin, args, {
        encoding: "utf8",
        timeout: 5000,
        shell: process.platform === "win32",
      });
      return r.status === 0;
    } catch {
      return false;
    }
  }
  if (provider === "gemini") {
    // Gemini doesn't have a dedicated auth check — a successful --version
    // is a reasonable proxy.
    try {
      const credsPath = path.join(os.homedir(), ".gemini", "gemini-credentials.json");
      return fs.existsSync(credsPath);
    } catch {
      return false;
    }
  }
  return false;
}

const PROVIDER_DOCS = {
  codex: "https://github.com/openai/codex#login",
  gemini: "https://github.com/google-gemini/gemini-cli",
  claude: "https://docs.anthropic.com/en/docs/claude-code",
};

const PROVIDER_PACKAGES = {
  gemini: "@google/gemini-cli",
  claude: "@anthropic-ai/claude-code",
};

const PROVIDER_LABELS = {
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  claude: "Claude Code",
};

/**
 * Provider-aware setup. Reads the saved provider from settings.json
 * and ensures the correct backend is ready:
 *   - codex  → existing wizard flow (binary + auth)
 *   - gemini → use bundled binary
 *   - claude → use bundled binary
 */
async function ensureProviderReady() {
  const provider = readSavedProvider();

  if (provider === "codex") {
    return ensureCodexReady();
  }

  const binPath = resolveBundledBinary(provider);

  // BYOK does not require a binary.
  if (provider === "pi") return true;

  if (!binPath) {
    const label = PROVIDER_LABELS[provider];
    const { dialog: d } = require("electron");
    d.showMessageBoxSync({
      type: "error",
      title: `${label} — Not Found`,
      message: `${label} could not be found. Your installation may be corrupted.`,
      buttons: ["Quit"],
    });
    return false;
  }

  // Check auth
  // Both Claude and Gemini use terminal-based authentication
  let authenticated = false;
  if (provider === "gemini") {
    try {
      const settingsPath = path.join(app.getPath("userData"), "settings.json");
      if (fs.existsSync(settingsPath)) {
        const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        if (raw.geminiApiKey) {
          process.env.GEMINI_API_KEY = raw.geminiApiKey;
          authenticated = true;
        }
      }
    } catch {}
  }
  
  if (!authenticated && (provider === "claude" || provider === "gemini")) {
    authenticated = isCliAuthenticated(binPath, provider);
  }

  if (!authenticated && (provider === "claude" || provider === "gemini")) {
    return showSetupWindow({ reason: "first-run", provider });
  }

  return true;
}

async function ensureCodexReady() {
  ensureIpcHandlers();
  let status = refreshCodexStatus();
  if (status.binaryFound && status.versionOk && status.loggedIn) {
    return true;
  }
  const ok = await showSetupWindow({ reason: "first-run" });
  
  const newProvider = readSavedProvider();
  if (newProvider !== "codex") {
    return await ensureProviderReady();
  }

  status = refreshCodexStatus();
  // Even if the wizard returned, only proceed if every gate is green.
  return ok && status.binaryFound && status.versionOk && status.loggedIn;
}

module.exports = {
  ensureCodexReady,
  ensureProviderReady,
  showSetupWindow,
  resolveCodexBinary,
  refreshCodexStatus,
  onCodexStatusChange,
  readSavedProvider,
  resolveBundledBinary,
};
