/**
 * Language Server Discovery
 *
 * Finds running Antigravity Language Server instances by:
 * 1. Reading daemon discovery files (~/.gemini/antigravity/daemon/ls_*.json)
 * 2. Scanning OS processes for language_server executables
 * 3. Merging results from both sources (deduped by PID)
 * 4. Enriching instances with workspaceId via GetWorkspaceInfos RPC
 *
 * Each LS instance is workspace-scoped, so there may be multiple.
 */

import { readdir, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { platformAdapter } from "./platform/index.js";
import { hasAliveSignal } from "./platform/shared.js";
import {
  getTransportOrder,
  rememberSuccessfulTransport,
  type TransportProtocol,
} from "./transport-hints.js";
import {
  ensureStandaloneCore,
  getStandaloneCorePid,
  yieldStandaloneCoreIfExternalExists,
} from "./core-manager.js";

export interface LSInstance {
  pid: number;
  httpsPort: number;
  httpPort: number;
  lspPort: number;
  csrfToken: string;
  workspaceId?: string;
  appDataDir?: string;
  /** Number of configured models reported by this LS (0 = unauthenticated/empty stub hub). */
  modelCount?: number;
  /** Derived from discovery source */
  source: "daemon" | "process";
}

const DAEMON_DIRS = [
  {
    dir: join(homedir(), ".gemini", "antigravity", "daemon"),
    appDataDir: "antigravity",
  },
  {
    dir: join(homedir(), ".gemini", "antigravity-ide", "daemon"),
    appDataDir: "antigravity-ide",
  },
  {
    dir: join(homedir(), ".gemini", "antigravity-cli", "daemon"),
    appDataDir: "antigravity-cli",
  },
];
const SERVICE_PREFIX = "exa.language_server_pb.LanguageServerService";

async function discoverFromDaemon(): Promise<LSInstance[]> {
  const instances: LSInstance[] = [];

  for (const { dir: daemonDir, appDataDir } of DAEMON_DIRS) {
    try {
      const files = await readdir(daemonDir);
      const lsFiles = files.filter(
        (file) =>
          (file.startsWith("ls_") || file.startsWith("hub_")) &&
          file.endsWith(".json"),
      );

      for (const file of lsFiles) {
        try {
          const raw = await readFile(join(daemonDir, file), "utf-8");
          const data = JSON.parse(raw);

          if (!data.pid || !data.httpsPort || !data.csrfToken) continue;
          if (!(await platformAdapter.isPidAlive(data.pid))) continue;

          instances.push({
            pid: data.pid,
            httpsPort: data.httpsPort,
            httpPort: data.httpPort ?? 0,
            lspPort: data.lspPort ?? 0,
            csrfToken: data.csrfToken,
            appDataDir,
            source: "daemon",
          });
        } catch {
          // Skip malformed files
        }
      }
    } catch {
      // Daemon dir missing or unreadable
    }
  }

  return instances;
}

async function discoverFromProcess(
  knownDaemonPids: ReadonlySet<number> = new Set(),
  preScannedCandidates?: Awaited<ReturnType<typeof platformAdapter.discoverFromProcess>>,
): Promise<LSInstance[]> {
  const instances: LSInstance[] = [];

  try {
    const candidates =
      preScannedCandidates ?? (await platformAdapter.discoverFromProcess());
    const pendingInstances: Array<{
      pid: number;
      csrfToken: string;
      workspaceId?: string;
      appDataDir?: string;
      httpsPort: number;
      httpPort: number;
      lspPort: number;
    }> = [];

    for (const candidate of candidates) {
      // Daemon discovery already verified this PID and its RPC port — skip redundant
      // ps/lsof/port-probe calls and only pass through metadata for merging.
      if (knownDaemonPids.has(candidate.pid)) {
        instances.push({
          pid: candidate.pid,
          httpsPort: candidate.httpsPort,
          httpPort: candidate.httpPort,
          lspPort: candidate.lspPort,
          csrfToken: candidate.csrfToken,
          workspaceId: candidate.workspaceId,
          appDataDir: candidate.appDataDir,
          source: "process",
        });
        continue;
      }

      if (!(await platformAdapter.isPidAlive(candidate.pid))) continue;

      if (candidate.httpsPort) {
        instances.push({
          pid: candidate.pid,
          httpsPort: candidate.httpsPort,
          httpPort: candidate.httpPort,
          lspPort: candidate.lspPort,
          csrfToken: candidate.csrfToken,
          workspaceId: candidate.workspaceId,
          appDataDir: candidate.appDataDir,
          source: "process",
        });
      } else {
        pendingInstances.push({
          pid: candidate.pid,
          csrfToken: candidate.csrfToken,
          workspaceId: candidate.workspaceId,
          appDataDir: candidate.appDataDir,
          httpsPort: 0,
          httpPort: candidate.httpPort,
          lspPort: candidate.lspPort,
        });
      }
    }

    if (pendingInstances.length > 0) {
      await Promise.allSettled(
        pendingInstances.map(async (pending) => {
          const allPorts = await platformAdapter.discoverPortsForPid(pending.pid);
          const knownPorts = new Set<number>();
          if (pending.httpPort) knownPorts.add(pending.httpPort);
          if (pending.lspPort) knownPorts.add(pending.lspPort);
          const candidates = allPorts.filter((port) => !knownPorts.has(port));

          const rpcPort = await probeConnectRpcPort(
            candidates.length > 0 ? candidates : allPorts,
            pending.csrfToken,
          );

          instances.push({
            pid: pending.pid,
            httpsPort: rpcPort,
            httpPort: pending.httpPort,
            lspPort: pending.lspPort,
            csrfToken: pending.csrfToken,
            workspaceId: pending.workspaceId,
            appDataDir: pending.appDataDir,
            source: "process",
          });
        }),
      );
    }
  } catch {
    // No matching processes
  }

  return instances;
}

/**
 * Probe candidate ports to find the one serving Connect RPC.
 * Tries the last successful transport first, with a short timeout.
 * Returns the first port that responds to GetWorkspaceInfos, or
 * falls back to the first candidate if none respond.
 */
export async function probeConnectRpcPort(
  candidates: number[],
  csrfToken: string,
): Promise<number> {
  if (candidates.length === 0) return 0;
  if (candidates.length === 1) return candidates[0];

  const attemptProbe = (
    port: number,
    protocol: TransportProtocol,
  ): Promise<boolean> =>
    new Promise((resolve) => {
      const payload = JSON.stringify({});
      const requestFn = protocol === "https" ? httpsRequest : httpRequest;
      const opts = {
        hostname: "127.0.0.1",
        port,
        path: `/${SERVICE_PREFIX}/GetWorkspaceInfos`,
        method: "POST" as const,
        headers: {
          "Content-Type": "application/json",
          "x-codeium-csrf-token": csrfToken,
          "Content-Length": Buffer.byteLength(payload),
        },
        ...(protocol === "https" ? { rejectUnauthorized: false } : {}),
      };

      const req = requestFn(opts, (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          resolve(
            res.statusCode !== undefined &&
              res.statusCode === 200,
          );
        });
      });

      req.on("error", () => resolve(false));
      req.setTimeout(800, () => {
        req.destroy();
        resolve(false);
      });
      req.write(payload);
      req.end();
    });

  const probe = async (port: number): Promise<boolean> => {
    const target = { httpsPort: port, csrfToken };
    for (const protocol of getTransportOrder(target)) {
      if (await attemptProbe(port, protocol)) {
        rememberSuccessfulTransport(target, protocol);
        return true;
      }
    }
    return false;
  };

  const results = await Promise.all(
    candidates.map(async (port) => ({ port, ok: await probe(port) })),
  );
  const found = results.find((result) => result.ok);
  return found?.port ?? candidates[0];
}

/** Convert a workspace URI to the LS workspaceId format. */
function uriToWorkspaceId(uri: string): string {
  return uri.replace(/^file:\/\/\//, "file_").replace(/\//g, "_");
}

/**
 * Query an LS instance's GetWorkspaceInfos endpoint to resolve its workspaceId.
 * Uses raw HTTP/HTTPS to avoid a circular dependency on RPCClient.
 */
async function queryWorkspaceInfo(
  inst: LSInstance,
): Promise<{ reachable: boolean; workspaceId?: string }> {
  const isWorkspaceInfoResponse = (
    data: unknown,
  ): data is {
    workspaceInfos?: { workspaceUri?: string }[];
    homeDirPath?: string;
    homeDirUri?: string;
  } => {
    if (!data || typeof data !== "object") return false;
    const payload = data as {
      workspaceInfos?: unknown;
      homeDirPath?: unknown;
      homeDirUri?: unknown;
    };
    return (
      Array.isArray(payload.workspaceInfos) ||
      typeof payload.homeDirPath === "string" ||
      typeof payload.homeDirUri === "string"
    );
  };

  const doPost = (
    protocol: TransportProtocol,
  ): Promise<{ reachable: boolean; workspaceId?: string } | undefined> =>
    new Promise((resolve) => {
      const payload = JSON.stringify({});
      const requestFn = protocol === "https" ? httpsRequest : httpRequest;
      const opts = {
        hostname: "127.0.0.1",
        port: inst.httpsPort,
        path: `/${SERVICE_PREFIX}/GetWorkspaceInfos`,
        method: "POST" as const,
        headers: {
          "Content-Type": "application/json",
          "x-codeium-csrf-token": inst.csrfToken,
          "Content-Length": Buffer.byteLength(payload),
        },
        ...(protocol === "https" ? { rejectUnauthorized: false } : {}),
      };

      const req = requestFn(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve(undefined);
            return;
          }

          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            if (!isWorkspaceInfoResponse(data)) {
              resolve(undefined);
              return;
            }
            const wsUri = data.workspaceInfos?.[0]?.workspaceUri as
              | string
              | undefined;
            resolve({
              reachable: true,
              workspaceId: wsUri ? uriToWorkspaceId(wsUri) : undefined,
            });
          } catch {
            resolve(undefined);
          }
        });
      });

      req.on("error", () => resolve(undefined));
      req.setTimeout(6000, () => {
        req.destroy();
        resolve(undefined);
      });
      req.write(payload);
      req.end();
    });

  for (const protocol of getTransportOrder(inst)) {
    const result = await doPost(protocol);
    if (result !== undefined) {
      rememberSuccessfulTransport(inst, protocol);
      return result;
    }
  }

  return { reachable: false };
}

async function queryModelCount(inst: LSInstance): Promise<number | undefined> {
  const doPost = (protocol: TransportProtocol): Promise<number | undefined> =>
    new Promise((resolve) => {
      const payload = JSON.stringify({});
      const requestFn = protocol === "https" ? httpsRequest : httpRequest;
      const opts = {
        hostname: "127.0.0.1",
        port: inst.httpsPort,
        path: `/${SERVICE_PREFIX}/GetCascadeModelConfigData`,
        method: "POST" as const,
        headers: {
          "Content-Type": "application/json",
          "x-codeium-csrf-token": inst.csrfToken,
          "Content-Length": Buffer.byteLength(payload),
        },
        ...(protocol === "https" ? { rejectUnauthorized: false } : {}),
      };

      const req = requestFn(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve(undefined);
            return;
          }
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
              clientModelConfigs?: unknown;
            };
            if (Array.isArray(data?.clientModelConfigs)) {
              resolve(data.clientModelConfigs.length);
              return;
            }
            // Some LS versions return `{}` when zero models are configured.
            if (data && typeof data === "object" && !Array.isArray(data)) {
              resolve(0);
              return;
            }
          } catch {
            // ignore non-JSON responses
          }
          resolve(undefined);
        });
      });

      req.on("error", () => resolve(undefined));
      req.setTimeout(3000, () => {
        req.destroy();
        resolve(undefined);
      });
      req.write(payload);
      req.end();
    });

  // queryWorkspaceInfo already recorded the working transport protocol for this LS.
  const [preferred] = getTransportOrder(inst);
  return doPost(preferred);
}

/**
 * Prioritize healthy LS instances that actually serve models over empty/unauthenticated
 * auxiliary `agy --hub` processes that report 0 models.
 */
export function sortInstancesByHealth(instances: LSInstance[]): LSInstance[] {
  const healthRank = (inst: LSInstance): number => {
    if (typeof inst.modelCount === "number") {
      return inst.modelCount > 0 ? 2 : 0;
    }
    return 1;
  };
  return [...instances].sort((a, b) => {
    const rankDiff = healthRank(b) - healthRank(a);
    if (rankDiff !== 0) return rankDiff;
    const countDiff = (b.modelCount ?? -1) - (a.modelCount ?? -1);
    if (countDiff !== 0) return countDiff;
    return 0;
  });
}

/**
 * Enrich instances that lack workspaceId by querying the LS directly.
 * This is the authoritative resolution when daemon or process metadata
 * is incomplete or stale.
 */
async function enrichReachableInstances(
  instances: LSInstance[],
): Promise<LSInstance[]> {
  const results = await Promise.all(
    instances.map(async (inst) => {
      const info = await queryWorkspaceInfo(inst);
      if (!info.reachable) return null;
      if (info.workspaceId) inst.workspaceId = info.workspaceId;
      const modelCount = await queryModelCount(inst);
      if (typeof modelCount === "number") {
        inst.modelCount = modelCount;
      }
      return inst;
    }),
  );

  return sortInstancesByHealth(
    results.filter((inst): inst is LSInstance => inst !== null),
  );
}

/**
 * Discover all running Language Server instances.
 *
 * Resolution order:
 * 1. Daemon files
 * 2. Process discovery
 * 3. RPC enrichment
 */
async function hasAliveExternalLS(): Promise<boolean> {
  const standalonePid = getStandaloneCorePid();
  // Fast direct check on daemon files using zero-fork kernel signal check first
  for (const { dir: daemonDir } of DAEMON_DIRS) {
    try {
      const files = await readdir(daemonDir);
      for (const file of files) {
        if (!(file.startsWith("ls_") || file.startsWith("hub_")) || !file.endsWith(".json")) {
          continue;
        }
        try {
          const data = JSON.parse(await readFile(join(daemonDir, file), "utf-8")) as {
            pid?: number;
          };
          if (
            typeof data.pid === "number" &&
            data.pid !== standalonePid &&
            hasAliveSignal(data.pid)
          ) {
            return true;
          }
        } catch {
          // ignore malformed file
        }
      }
    } catch {
      // ignore missing daemon dir
    }
  }
  const [daemonInstances, processCandidates] = await Promise.all([
    discoverFromDaemon(),
    platformAdapter.discoverFromProcess().catch(() => []),
  ]);
  if (daemonInstances.some((inst) => inst.pid !== standalonePid)) {
    return true;
  }
  for (const cand of processCandidates) {
    if (cand.pid === standalonePid) continue;
    if (hasAliveSignal(cand.pid) || (await platformAdapter.isPidAlive(cand.pid))) {
      return true;
    }
  }
  return false;
}

export async function discoverInstances(): Promise<LSInstance[]> {
  const daemonInstances = await discoverFromDaemon();
  const processPromise = platformAdapter.discoverFromProcess().catch(() => []);
  // When daemon discovery already found alive hub/LS entries, don't let a slow
  // `ps -axo` scan stall requests for 5+ seconds under heavy host CPU load.
  const processCandidates =
    daemonInstances.length > 0
      ? await Promise.race([
          processPromise,
          new Promise<Awaited<typeof processPromise>>((resolve) =>
            setTimeout(() => resolve([]), 1500),
          ),
        ])
      : await processPromise;
  const knownDaemonPids = new Set(
    daemonInstances
      .filter((inst) => inst.pid && inst.httpsPort > 0)
      .map((inst) => inst.pid),
  );
  const processInstances = await discoverFromProcess(
    knownDaemonPids,
    processCandidates,
  );

  const instanceMap = new Map<number, LSInstance>();

  for (const daemonInstance of daemonInstances) {
    if (daemonInstance.pid && !Number.isNaN(daemonInstance.pid)) {
      instanceMap.set(daemonInstance.pid, daemonInstance);
    }
  }

  for (const processInstance of processInstances) {
    const existing = instanceMap.get(processInstance.pid);
    if (existing) {
      existing.httpsPort = existing.httpsPort || processInstance.httpsPort;
      existing.httpPort = existing.httpPort || processInstance.httpPort;
      existing.lspPort = existing.lspPort || processInstance.lspPort;
      existing.csrfToken = existing.csrfToken || processInstance.csrfToken;
      existing.appDataDir = existing.appDataDir || processInstance.appDataDir;
      if (!existing.workspaceId && processInstance.workspaceId) {
        existing.workspaceId = processInstance.workspaceId;
      }
    } else {
      instanceMap.set(processInstance.pid, processInstance);
    }
  }

  const instances = Array.from(instanceMap.values());
  return enrichReachableInstances(instances);
}

/**
 * Cached discovery with auto-refresh on error.
 */
export class LSDiscovery {
  private instances: LSInstance[] = [];
  private lastDiscovery = 0;
  private readonly ttlMs: number;
  private readonly staleTtlMs: number;
  private pendingDiscovery: Promise<LSInstance[]> | null = null;
  private discoveryGeneration = 0;

  constructor(ttlMs = 20_000, staleTtlMs?: number) {
    this.ttlMs = ttlMs;
    this.staleTtlMs =
      staleTtlMs ?? (process.env.VITEST ? 0 : 180_000);
  }

  protected async discover(): Promise<LSInstance[]> {
    let instances = await discoverInstances();
    if (instances.length === 0) {
      // Avoid spawning a conflicting standalone headless hub when an external
      // IDE/app LS process is already alive and only transiently busy.
      const externalAlive = await hasAliveExternalLS();
      if (externalAlive) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        instances = await discoverInstances();
      } else {
        await ensureStandaloneCore();
        instances = await discoverInstances();
      }
    } else {
      const yieldedPid = yieldStandaloneCoreIfExternalExists(instances);
      if (yieldedPid !== null) {
        instances = instances.filter((inst) => inst.pid !== yieldedPid);
      }
    }
    return instances;
  }

  invalidateCache(): void {
    this.lastDiscovery = 0;
  }

  private startBackgroundRefresh(): Promise<LSInstance[]> {
    if (this.pendingDiscovery) {
      return this.pendingDiscovery;
    }
    const generation = ++this.discoveryGeneration;
    const pending = this.discover()
      .then((discovered) => {
        if (generation === this.discoveryGeneration) {
          if (discovered.length > 0) {
            this.instances = discovered;
            this.lastDiscovery = Date.now();
          } else {
            // Preserve previously verified LS instances that are still alive
            // via kernel signal so transient RPC/CPU load spikes never wipe
            // languageServers to [] and blank out chat messages.
            const stillAlive = this.instances.filter((inst) =>
              hasAliveSignal(inst.pid),
            );
            this.instances = stillAlive;
            this.lastDiscovery = stillAlive.length > 0 ? Date.now() - this.ttlMs + 5_000 : Date.now();
            return stillAlive;
          }
        }
        return discovered;
      })
      .finally(() => {
        if (this.pendingDiscovery === pending) {
          this.pendingDiscovery = null;
        }
      });

    this.pendingDiscovery = pending;
    return pending;
  }

  async getInstances(
    forceRefresh = false,
    targetAppDataDir?: string,
  ): Promise<LSInstance[]> {
    const now = Date.now();
    const age = now - this.lastDiscovery;
    const cacheFresh =
      !forceRefresh &&
      this.instances.length > 0 &&
      age <= this.ttlMs;

    const canServeStale =
      !forceRefresh &&
      !cacheFresh &&
      this.staleTtlMs > 0 &&
      this.instances.length > 0 &&
      age <= this.staleTtlMs &&
      this.instances.some((inst) => hasAliveSignal(inst.pid));

    let instances: LSInstance[];
    if (cacheFresh) {
      instances = this.instances;
    } else if (canServeStale) {
      // SWR: return alive cached instances immediately so /api/health and chat
      // sends never stall for seconds while LS discovery revalidates in background.
      instances = this.instances;
      void this.startBackgroundRefresh().catch(() => {});
    } else if (!forceRefresh && this.pendingDiscovery) {
      instances = await this.pendingDiscovery;
    } else {
      instances = await this.startBackgroundRefresh();
    }

    if (targetAppDataDir && targetAppDataDir !== "all") {
      return instances.filter((inst) => inst.appDataDir === targetAppDataDir);
    }
    return instances;
  }

  /**
   * Get the first available instance (or a specific workspace).
   */
  async getInstance(
    workspaceId?: string,
    targetAppDataDir?: string,
  ): Promise<LSInstance | null> {
    const instances = await this.getInstances(false, targetAppDataDir);

    if (workspaceId) {
      return instances.find((inst) => inst.workspaceId === workspaceId) ?? null;
    }

    return instances[0] ?? null;
  }

  /** Force re-discovery (e.g. on connection error). */
  invalidate(): void {
    this.discoveryGeneration++;
    this.lastDiscovery = 0;
    this.pendingDiscovery = null;
  }
}
