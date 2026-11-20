import { hasAliveSignal, parseLsofPorts, parsePsCandidates, runCommand } from "./shared.js";
import type { PlatformAdapter } from "./types.js";

const verifiedLsPids = new Set<number>();

export const darwinAdapter: PlatformAdapter = {
  id: "darwin",

  async isPidAlive(pid) {
    if (!hasAliveSignal(pid)) {
      verifiedLsPids.delete(pid);
      return false;
    }

    // Fast path: already confirmed as an Antigravity LS/agy process and still alive.
    if (verifiedLsPids.has(pid)) {
      return true;
    }

    try {
      const comm = (
        await runCommand("ps", ["-p", String(pid), "-o", "comm="], 2500)
      ).trim();
      const matched = comm.includes("language_server") || comm.includes("agy");
      if (matched) {
        verifiedLsPids.add(pid);
      }
      return matched;
    } catch {
      // Under extreme macOS CPU load, spawning `ps` can time out even while the
      // kernel signal check (`process.kill(pid, 0)`) confirmed the PID is alive.
      // Return true here and let discovery's authenticated GetWorkspaceInfos RPC
      // (csrfToken + port) authoritatively verify the process instead of falsely
      // declaring Antigravity LS dead and spawning a conflicting headless hub.
      return hasAliveSignal(pid);
    }
  },

  async discoverFromProcess() {
    try {
      const output = await runCommand("ps", ["-axo", "pid=,args="]);
      return parsePsCandidates(output);
    } catch {
      return [];
    }
  },

  async discoverPortsForPid(pid) {
    try {
      const output = await runCommand("lsof", [
        "-nP",
        "-iTCP",
        "-sTCP:LISTEN",
        "-a",
        "-p",
        String(pid),
      ]);
      return parseLsofPorts(output);
    } catch {
      return [];
    }
  },
};
