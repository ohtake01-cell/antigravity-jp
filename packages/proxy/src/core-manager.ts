import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let coreProcess: ChildProcess | null = null;
let coreDaemonFile: string | null = null;
let startPromise: Promise<void> | null = null;

export function getStandaloneCorePid(): number | null {
  if (coreProcess && coreProcess.exitCode === null && coreProcess.pid) {
    return coreProcess.pid;
  }
  return null;
}

function cleanupDaemonFile(filePath: string | null): void {
  if (!filePath) return;
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // non-fatal
  }
}

function resolveAgyBinary(): string {
  if (process.env.PORTA_CORE_BINARY_PATH) {
    return process.env.PORTA_CORE_BINARY_PATH;
  }
  const homeBin = join(homedir(), ".gemini", "bin", "agy");
  if (existsSync(homeBin)) {
    return homeBin;
  }
  return "agy";
}

export async function ensureStandaloneCore(): Promise<void> {
  if (process.env.PORTA_STANDALONE_CORE !== "true") {
    return;
  }

  if (coreProcess && coreProcess.exitCode === null) {
    return;
  }

  if (startPromise) {
    await startPromise;
    return;
  }

  startPromise = (async () => {
    try {
      const binaryPath = resolveAgyBinary();
      const isWin = process.platform === "win32";
      const basename = binaryPath.replace(/^.*[\\/]/, "").toLowerCase();
      const isAgyCli = basename === "agy" || basename === "agy.exe";
      const appDataDir = process.env.PORTA_CORE_APP_DATA_DIR || "antigravity";
      const hubPort = process.env.PORTA_CORE_HUB_PORT || "55371";
      const csrfToken = randomUUID();
      let expectedDaemonFile: string | null = null;

      if (isAgyCli) {
        if (isWin) {
          console.log(`[Core Manager] Starting standalone Antigravity CLI on Windows...`);
          coreProcess = spawn(binaryPath, [], {
            stdio: "ignore",
            detached: true,
          });
        } else {
          console.log(
            `[Core Manager] Starting headless agy --hub on port ${hubPort} (${appDataDir})...`,
          );
          expectedDaemonFile = join(
            homedir(),
            ".gemini",
            appDataDir,
            "daemon",
            `hub_${hubPort}.json`,
          );
          cleanupDaemonFile(expectedDaemonFile);
          coreDaemonFile = expectedDaemonFile;
          const cleanHubEnv: NodeJS.ProcessEnv = { ...process.env, AGY_ENABLE_HUB: "1" };
          // Prevent Porta production runtime env vars from leaking into user agent shells spawned by agy --hub.
          delete cleanHubEnv.NODE_ENV;
          delete cleanHubEnv.PORTA_ALLOW_WILDCARD;
          delete cleanHubEnv.PORTA_HOST;
          delete cleanHubEnv.PORTA_PORT;
          delete cleanHubEnv.PORTA_WEB_PORT;
          delete cleanHubEnv.PORTA_TAILSCALE;
          delete cleanHubEnv.PORTA_CORS_ORIGINS;
          delete cleanHubEnv.PORTA_ALLOWED_HOSTS;
          coreProcess = spawn(
            binaryPath,
            [
              "--hub",
              `--hub-port=${hubPort}`,
              `--app_data_dir=${appDataDir}`,
              `--csrf_token=${csrfToken}`,
            ],
            {
              stdio: "ignore",
              detached: true,
              env: cleanHubEnv,
            },
          );
        }
      } else {
        console.log(`[Core Manager] Starting standalone Antigravity core from ${binaryPath} with csrf ${csrfToken}...`);

        coreProcess = spawn(
          binaryPath,
          [
            "--standalone",
            "--override_ide_name", "antigravity",
            "--subclient_type", "hub",
            "--override_ide_version", "2.2.1",
            "--override_user_agent_name", "antigravity",
            "--https_server_port", "0",
            "--csrf_token", csrfToken,
            "--app_data_dir", appDataDir,
            "--api_server_url", "https://generativelanguage.googleapis.com",
            "--cloud_code_endpoint", "https://daily-cloudcode-pa.googleapis.com",
            "--enable_sidecars",
          ],
          {
            stdio: ["pipe", "ignore", "ignore"],
            detached: true,
          }
        );
      }

      coreProcess.on("error", (err) => {
        console.error(`[Core Manager] Failed to start standalone core:`, err);
        coreProcess = null;
      });

      coreProcess.on("exit", (code) => {
        console.log(`[Core Manager] Standalone core exited with code ${code}`);
        cleanupDaemonFile(coreDaemonFile);
        coreDaemonFile = null;
        coreProcess = null;
      });

      // Unref so it doesn't keep the proxy alive unnecessarily, though we want it to run as long as proxy runs.
      coreProcess.unref();

      // Wait up to 8s for the hub daemon discovery file to appear
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (!coreProcess) break;
        if (expectedDaemonFile && existsSync(expectedDaemonFile)) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      startPromise = null;
    }
  })();

  await startPromise;
}

/**
 * If an external (Antigravity IDE / app) Language Server is running alongside
 * our temporary standalone headless core, yield ownership immediately so IDE
 * and Porta never write to the same conversation SQLite DB from two hubs.
 */
export function yieldStandaloneCoreIfExternalExists(
  instances: ReadonlyArray<{ pid: number }>,
): number | null {
  const standalonePid = getStandaloneCorePid();
  if (!standalonePid) return null;
  const hasExternal = instances.some((inst) => inst.pid !== standalonePid);
  if (!hasExternal) return null;
  console.log(
    `[Core Manager] External Antigravity LS detected; yielding standalone core (pid=${standalonePid}) to avoid dual-hub conflict.`,
  );
  stopStandaloneCore();
  return standalonePid;
}

export function stopStandaloneCore() {
  if (coreProcess) {
    console.log("[Core Manager] Stopping standalone Antigravity core...");
    const pid = coreProcess.pid;
    try {
      if (pid && process.platform !== "win32") {
        process.kill(-pid, "SIGTERM");
      } else {
        coreProcess.kill("SIGTERM");
      }
    } catch {
      try {
        coreProcess.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
    coreProcess = null;
  }
  cleanupDaemonFile(coreDaemonFile);
  coreDaemonFile = null;
}
