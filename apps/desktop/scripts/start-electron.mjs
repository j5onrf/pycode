import * as path from "node:path";
import * as NodeChildProcess from "node:child_process";

import { desktopDir, resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const userArgs = process.argv.slice(2);
const targetCwd = userArgs[0] || process.env.AI_WORKSPACE_PATH || process.cwd();
const mainScript = path.join(desktopDir, "dist-electron", "main.cjs");

const electronCommand = resolveElectronLaunchCommand([mainScript, targetCwd]);

const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: "inherit",
  cwd: desktopDir,
  env: {
    ...childEnv,
    T3CODE_CWD: targetCwd,
    AI_WORKSPACE_PATH: targetCwd,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
