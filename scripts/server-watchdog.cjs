/**
 * Server watchdog — boots .next/standalone/server.js inside a child
 * process and exits (taking the child with it) if our parent dies.
 *
 * Why this exists: even with detached:true + process-group tree-kill in
 * the Electron main, there's a corner case — Activity Monitor "Force
 * Quit", a sudden kernel SIGKILL, an unrecoverable crash — where the
 * Electron main dies before any of its cleanup runs. In that case our
 * server (a child of the main) gets reparented to launchd/init and
 * keeps running. This watchdog process notices the reparenting
 * (ppid === 1 on POSIX, parent pid disappears on Windows) and shuts
 * down. Effectively a dead-man's-switch.
 *
 * Run as the spawn target instead of server.js directly.
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const PARENT_PID_AT_BOOT = process.ppid;
const WATCHDOG_INTERVAL_MS = 1000;

// Locate server.js — same directory as this script when packaged
// (electron-builder ships both inside .next/standalone), or one
// level up in dev where we run from the repo root.
function findServerJs() {
  const candidates = [
    path.join(__dirname, "server.js"),
    path.join(__dirname, "..", ".next", "standalone", "server.js"),
    path.join(process.cwd(), ".next", "standalone", "server.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("server-watchdog: could not find server.js");
}

const serverPath = findServerJs();
const serverDir = path.dirname(serverPath);

const child = spawn(process.execPath, [serverPath], {
  cwd: serverDir,
  env: process.env,
  stdio: ["ignore", "inherit", "inherit"],
});

let shuttingDown = false;
function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Graceful first: SIGTERM the server so it can flush.
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    // Then reap the WHOLE subtree — the server plus any AI subprocesses it
    // spawned (codex/claude/gemini/pi). Electron spawned this watchdog
    // detached, so on POSIX we're the process-group leader and a negative-pid
    // signal hits the entire group. On Windows, taskkill /t walks the tree.
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        try {
          process.kill(-process.pid, "SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }
    } catch {
      /* ignore */
    }
    process.exit(exitCode);
  }, 200);
}

child.once("exit", (code) => shutdown(typeof code === "number" ? code : 0));
child.once("error", () => shutdown(1));

// Parent-death detection: if our parent disappears (ppid becomes 1 on
// POSIX, ppid getter throws / parent absent on Windows), die.
function checkParent() {
  if (shuttingDown) return;
  if (process.platform === "win32") {
    // Windows: ppid is set at fork-time and doesn't update. We instead
    // try kill 0 on the original parent pid — if it errors, parent gone.
    try {
      process.kill(PARENT_PID_AT_BOOT, 0);
    } catch {
      shutdown(0);
    }
    return;
  }
  if (process.ppid === 1 && PARENT_PID_AT_BOOT !== 1) {
    // Reparented to launchd/init → our actual parent died.
    shutdown(0);
  }
}
setInterval(checkParent, WATCHDOG_INTERVAL_MS);

// Forward common termination signals to the child.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => shutdown(sig === "SIGINT" ? 130 : 143));
}
