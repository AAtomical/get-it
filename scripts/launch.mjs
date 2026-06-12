import { spawn } from "node:child_process";
import electronPath from "electron";

// Delete the environment variable to ensure Electron does not start as Node.
// This is necessary because some IDEs (like VS Code) set ELECTRON_RUN_AS_NODE=1
// in the integrated terminal, which leaks into Electron and crashes the GUI.
delete process.env.ELECTRON_RUN_AS_NODE;

const args = ["."];

const child = spawn(electronPath, args, {
  stdio: "inherit",
});

child.on("close", (code) => {
  process.exit(code !== null ? code : 1);
});
