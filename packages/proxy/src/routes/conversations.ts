/**
 * /api/conversations/* routes
 */

import type { Hono } from "hono";
import type { LSInstance } from "../discovery.js";
import {
  discovery,
  rpc,
  conversationAffinity,
  conversationInstanceAffinity,
  uriToWorkspaceId,
  normalizeWorkspaceId,
  rpcForConversation,
  getStepCount,
  getTrajectorySummary,
  extractTargetAppDataDir,
} from "../routing.js";
import {
  extractConversationWorkspaces,
  conversationDirsForAppDataDirs,
  getMetadata,
  getPrimaryWorkspaceUri,
  scanDiskConversations,
  withNormalizedConversationWorkspaces,
  getProjectNameMap,
  getWorkspaceToProjectIdMap,
  getConversationTitleFromDisk,
  getConversationAnnotationsFromDisk,
  loadDiskAnnotationsMap,
  setConversationTitleOnDisk,
  setConversationAnnotationsOnDisk,
  scanArchivedDiskConversations,
  syncIntentionalArchiveRegistry,
  isSyntheticConversationId,
  isSubagentDiskConversation,
  getChildSubagentsFromDisk,
  getDetailedSubagentsFromDisk,
  getConversationBackgroundTasksFromDisk,
  getConversationTaskSummaryFromDisk,
  getConversationModelFromTranscript,
  getRecordedConversationModel,
  recordConversationModel,
  inferModelProvider,
  type ChildSubagentDiskInfo,
  type ModelProviderId,
} from "../metadata.js";
import { fetchMergedLSModels } from "./models.js";
import { handleRPCError } from "../errors.js";
import { runConversationMutation } from "../conversation-mutations.js";
import {
  resolveSmartConversationTitle,
  saveManualTitleLock,
} from "../title-formatter.js";
import {
  getUserMeta,
  setPinnedOverride,
  setProjectAssignment,
} from "../user-meta.js";
import {
  oversizedStepOffset,
  isRecoverableStepError,
  findNextValidOffset,
  placeholderStep,
  MAX_SKIP,
} from "../step-recovery.js";
import { sanitizeStepsForClient } from "../step-sanitizer.js";
import { messageTracker } from "../message-tracker.js";
import { conversationSignals } from "../signals.js";

const VALID_AUTO_EXECUTION_POLICIES = new Set([
  "CASCADE_COMMANDS_AUTO_EXECUTION_OFF",
  "CASCADE_COMMANDS_AUTO_EXECUTION_PROCEED_IN_SANDBOX",
  "CASCADE_COMMANDS_AUTO_EXECUTION_AUTO",
  "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER",
]);

const MAX_STEPS_LIMIT = 500;
const MAX_TOTAL_CONVERSATIONS = 100;
const MODEL_LABEL_MAP_TTL_MS = 30_000;

interface ModelLabelMaps {
  idToLabel: Map<string, string>;
  labelToId: Map<string, string>;
}

const modelLabelMapCache = new Map<
  string,
  { fetchedAt: number; maps: ModelLabelMaps }
>();

const stepGeneratorModelCache = new Map<
  string,
  { cacheKey: string; model: string | null }
>();

function isOpaqueModelKey(value: string): boolean {
  return /^MODEL_PLACEHOLDER_/i.test(value) || /^MODEL_[A-Z0-9_]+$/.test(value);
}

async function getModelLabelMaps(
  targetApp?: string,
): Promise<ModelLabelMaps> {
  const key = targetApp ?? "__all__";
  const cached = modelLabelMapCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < MODEL_LABEL_MAP_TTL_MS) {
    return cached.maps;
  }

  try {
    const payload = await fetchMergedLSModels(targetApp);
    const idToLabel = new Map<string, string>();
    const labelToId = new Map<string, string>();
    for (const cfg of payload.clientModelConfigs ?? []) {
      const id = cfg.modelOrAlias?.model?.trim();
      const label = cfg.label?.trim();
      if (id && label) {
        idToLabel.set(id, label);
        const normLabel = label.toLowerCase();
        if (!labelToId.has(normLabel)) {
          labelToId.set(normLabel, id);
        }
      }
    }
    const maps = { idToLabel, labelToId };
    modelLabelMapCache.set(key, { fetchedAt: Date.now(), maps });
    return maps;
  } catch {
    return (
      cached?.maps ?? {
        idToLabel: new Map<string, string>(),
        labelToId: new Map<string, string>(),
      }
    );
  }
}

function resolveHumanModelLabel(
  rawModel: string | null,
  labelMap: Map<string, string>,
): string | null {
  if (!rawModel) return null;
  const trimmed = rawModel.trim();
  if (!trimmed) return null;
  const mapped = labelMap.get(trimmed);
  if (mapped) return mapped;
  // Never expose raw opaque placeholder keys to the UI
  if (/^MODEL_PLACEHOLDER_/i.test(trimmed)) return null;
  if (/^MODEL_OPENAI_GPT_OSS_120B_MEDIUM$/i.test(trimmed)) {
    return "GPT-OSS 120B (Medium)";
  }
  if (/^MODEL_[A-Z0-9_]+$/.test(trimmed)) {
    return trimmed
      .replace(/^MODEL_/, "")
      .split("_")
      .map((part) => {
        if (/^GPT$/i.test(part)) return "GPT";
        if (/^OSS$/i.test(part)) return "OSS";
        if (/^\d/.test(part)) return part;
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      })
      .join(" ");
  }
  return trimmed;
}

async function getLastStepGeneratorModel(
  id: string,
  stepCount: number,
  inst: LSInstance | undefined,
  options?: { allowZeroOffset?: boolean; cacheKey?: string },
): Promise<string | null> {
  if (process.env.VITEST || !inst) return null;
  if (stepCount <= 0 && !options?.allowZeroOffset) return null;
  const cacheKey = options?.cacheKey ?? String(stepCount);
  const cached = stepGeneratorModelCache.get(id);
  if (cached && cached.cacheKey === cacheKey) {
    return cached.model;
  }

  try {
    let effectiveCount = stepCount;
    if (effectiveCount <= 0) {
      const summary = await getTrajectorySummary(id, inst, true);
      effectiveCount = summary?.count ?? 0;
    }
    if (effectiveCount <= 0) {
      stepGeneratorModelCache.set(id, { cacheKey, model: null });
      return null;
    }
    const stepOffset = Math.max(0, effectiveCount - 10);
    const data = await rpc.call<{
      steps?: Array<{ metadata?: { generatorModel?: string } }>;
    }>(
      "GetCascadeTrajectorySteps",
      { cascadeId: id, stepOffset },
      inst,
    );
    const steps = data.steps ?? [];
    let found: string | null = null;
    for (let i = steps.length - 1; i >= 0; i--) {
      const m = steps[i]?.metadata?.generatorModel?.trim();
      if (m) {
        found = m;
        break;
      }
    }
    stepGeneratorModelCache.set(id, { cacheKey, model: found });
    return found;
  } catch {
    return null;
  }
}

interface ResolvedConversationModel {
  model?: string;
  modelLabel: string;
  modelProvider: ModelProviderId;
}

async function resolveConversationModels(
  items: Array<{
    id: string;
    stepCount: number;
    fallbackInst?: LSInstance;
    allowZeroOffset?: boolean;
    cacheKey?: string;
  }>,
  activeAppDirs: readonly string[],
  targetApp: string | undefined,
  allowStepFallback: boolean,
): Promise<Map<string, ResolvedConversationModel>> {
  let stepFallbackBudget = 16;
  const rawResults: Array<{ id: string; raw: string | null }> = [];
  const MODEL_RESOLVE_CONCURRENCY = 8;

  for (let i = 0; i < items.length; i += MODEL_RESOLVE_CONCURRENCY) {
    const batch = items.slice(i, i + MODEL_RESOLVE_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async ({ id, stepCount, fallbackInst, allowZeroOffset, cacheKey }) => {
        const recorded = getRecordedConversationModel(id);
        if (recorded?.model) {
          return { id, raw: recorded.model };
        }
        const fromTranscript = await getConversationModelFromTranscript(
          id,
          activeAppDirs,
        );
        if (fromTranscript) {
          return { id, raw: fromTranscript };
        }
        if (allowStepFallback && (stepCount > 0 || allowZeroOffset)) {
          const inst = conversationInstanceAffinity.get(id) ?? fallbackInst;
          const effectiveKey = cacheKey ?? String(stepCount);
          const alreadyCached =
            stepGeneratorModelCache.get(id)?.cacheKey === effectiveKey;
          if (inst && (alreadyCached || stepFallbackBudget > 0)) {
            if (!alreadyCached) stepFallbackBudget--;
            const fromSteps = await getLastStepGeneratorModel(
              id,
              stepCount,
              inst,
              { allowZeroOffset, cacheKey: effectiveKey },
            );
            if (fromSteps) {
              return { id, raw: fromSteps };
            }
          }
        }
        return { id, raw: null as string | null };
      }),
    );
    rawResults.push(...batchResults);
  }

  const hasAnyRaw = rawResults.some((entry) => entry.raw !== null);
  const needsLabelMaps =
    rawResults.some(
      (entry) => entry.raw !== null && isOpaqueModelKey(entry.raw),
    ) ||
    (!process.env.VITEST && hasAnyRaw);
  const { idToLabel, labelToId } = needsLabelMaps
    ? await getModelLabelMaps(targetApp)
    : {
        idToLabel: new Map<string, string>(),
        labelToId: new Map<string, string>(),
      };

  const resolved = new Map<string, ResolvedConversationModel>();
  for (const { id, raw } of rawResults) {
    if (!raw) continue;
    const label = resolveHumanModelLabel(raw, idToLabel);
    if (!label) continue;
    const resolvedModelId = isOpaqueModelKey(raw)
      ? raw
      : labelToId.get(label.toLowerCase());
    resolved.set(id, {
      ...(resolvedModelId ? { model: resolvedModelId } : {}),
      modelLabel: label,
      modelProvider: inferModelProvider(label),
    });
  }
  return resolved;
}

interface ConversationCandidate {
  id: string;
  modifiedAt: number;
  summary: Record<string, unknown>;
}

function parseConversationTime(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function compareConversationCandidates(
  a: ConversationCandidate,
  b: ConversationCandidate,
): number {
  return b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id);
}

// ── Background warm-up for disk-only conversations ──

/** Warm-up cache: cascadeId → timestamp when the warm-up was initiated. */
const warmedAt = new Map<string, number>();
/** How long a warm-up result is considered valid (ms). After this, the
 *  conversation will be re-warmed on the next poll if still disk-only.
 *  This handles LS restarts (conversations fall out of memory) and
 *  transient failures without manual intervention. */
const WARM_TTL_MS = 60_000;

function requestedWorkspaceUris(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.workspaceUris)) return [];
  return body.workspaceUris.filter(
    (uri): uri is string => typeof uri === "string" && uri.length > 0,
  );
}

async function discoverSingleWorkspaceUri(
  instances: LSInstance[],
): Promise<string | undefined> {
  const byWorkspaceId = new Map<string, string>();
  const addUri = (uri: string | undefined) => {
    if (!uri) return;
    byWorkspaceId.set(normalizeWorkspaceId(uriToWorkspaceId(uri)), uri);
  };

  await Promise.allSettled(
    instances.map(async (inst) => {
      try {
        const data = (await rpc.call("GetWorkspaceInfos", {}, inst)) as {
          workspaceInfos?: { workspaceUri?: string }[];
        };
        for (const info of data.workspaceInfos ?? []) addUri(info.workspaceUri);
      } catch {
        // Fallback below can still recover workspace metadata from summaries.
      }
    }),
  );

  await Promise.allSettled(
    instances.map(async (inst) => {
      try {
        const data = await rpc.call<{
          trajectorySummaries?: Record<string, Record<string, unknown>>;
        }>("GetAllCascadeTrajectories", {}, inst);
        for (const summary of Object.values(data.trajectorySummaries ?? {})) {
          for (const workspace of extractConversationWorkspaces(summary)) {
            addUri(workspace.workspaceFolderAbsoluteUri);
          }
        }
      } catch {
        // If summaries are unavailable, keep whatever GetWorkspaceInfos found.
      }
    }),
  );

  return byWorkspaceId.size === 1 ? [...byWorkspaceId.values()][0] : undefined;
}

/**
 * Fire-and-forget: touch each disk-only conversation on every LS so the LS
 * loads its .pb file into memory. On the *next* GetAllCascadeTrajectories call
 * the LS will return it with proper workspace metadata and summary.
 *
 * Uses GetCascadeTrajectorySteps with a huge offset so the LS loads the .pb
 * but returns only `{steps:[]}` (~28 bytes) instead of the full trajectory.
 *
 * HACK: There is no dedicated "load conversation" RPC on the LS. We rely on
 * the side-effect of GetCascadeTrajectorySteps loading the .pb from disk.
 * If the LS changes its boundary-check or authorization behavior, this may
 * silently stop working — watch for "warm-up: failed" log lines.
 *
 * Concurrency is capped to avoid flooding the LS with reads.
 */
function warmUpDiskConversations(
  ids: string[],
  instances: LSInstance[],
): void {
  const now = Date.now();
  const pending = ids.filter((id) => {
    const t = warmedAt.get(id);
    return !t || now - t > WARM_TTL_MS;
  });
  if (pending.length === 0) return;
  for (const id of pending) warmedAt.set(id, now);

  console.log(
    `[warm-up] loading ${pending.length} disk-only conversation(s) across ${instances.length} LS(es)`,
  );

  const CONCURRENCY = 10;

  void (async () => {
    let loaded = 0;
    let failed = 0;

    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const batch = pending.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (cascadeId) => {
          for (const inst of instances) {
            try {
              await rpc.call(
                "GetCascadeTrajectorySteps",
                { cascadeId, stepOffset: 999999 },
                inst,
              );
              loaded++;
              return;
            } catch {
              // This LS doesn't have it — try next
            }
          }
          failed++;
        }),
      );
    }

    if (failed > 0) {
      console.log(
        `[warm-up] done: ${loaded} loaded, ${failed} failed (no LS could load them)`,
      );
    } else {
      console.log(`[warm-up] done: ${loaded} loaded`);
    }
  })();
}


export function registerConversationRoutes(app: Hono): void {
  app.get("/api/conversations", async (c) => {
    try {
      const targetApp = extractTargetAppDataDir(c);
      const [projectNameMap, wsToProjectMap, diskAnnotationsMap, userMeta, instances] =
        await Promise.all([
          getProjectNameMap(),
          getWorkspaceToProjectIdMap(),
          loadDiskAnnotationsMap(),
          getUserMeta(),
          discovery.getInstances(false, targetApp),
        ]);
      const merged: Record<string, Record<string, unknown>> = {};
      const excludedIds = new Set<string>();
      const subagentsByParent = new Map<string, Map<string, ChildSubagentDiskInfo>>();

      const upsertChildSubagent = (parentId: string, child: ChildSubagentDiskInfo) => {
        let bucket = subagentsByParent.get(parentId);
        if (!bucket) {
          bucket = new Map<string, ChildSubagentDiskInfo>();
          subagentsByParent.set(parentId, bucket);
        }
        const prev = bucket.get(child.id);
        if (!prev) {
          bucket.set(child.id, child);
          return;
        }
        const prevRunning = prev.status === "CASCADE_RUN_STATUS_RUNNING";
        const nextRunning = child.status === "CASCADE_RUN_STATUS_RUNNING";
        const prevSteps = prev.stepCount ?? -1;
        const nextSteps = child.stepCount ?? -1;
        if (
          (nextRunning && !prevRunning) ||
          (nextRunning === prevRunning &&
            (nextSteps > prevSteps ||
              (nextSteps === prevSteps &&
                parseConversationTime(child.lastModifiedTime) >
                  parseConversationTime(prev.lastModifiedTime))))
        ) {
          bucket.set(child.id, {
            ...prev,
            ...child,
            role: child.role || prev.role,
            typeName: child.typeName || prev.typeName,
          });
        }
      };

      // Build normalized set of workspaceIds served by running LS instances.
      // Normalization handles format differences between CLI --workspace_id
      // (e.g. file_e_3A_Work_novels) and URI-derived IDs (e.g. file_E:_Work_novels).
      const knownWsIds = new Set(
        instances
          .map((i) => i.workspaceId)
          .filter(Boolean)
          .map((id) => normalizeWorkspaceId(id!)),
      );

      let anyProjectScopedLS = false;

      await Promise.allSettled(
        instances.map(async (inst) => {
          try {
            const data = await rpc.call<{
              trajectorySummaries: Record<string, Record<string, unknown>>;
            }>("GetAllCascadeTrajectories", {}, inst);
            const summaries = data.trajectorySummaries ?? {};
            const hasProjectIdsInBatch = Object.values(summaries).some(
              (s: any) =>
                typeof s?.trajectoryMetadata?.projectId === "string" &&
                s.trajectoryMetadata.projectId.length > 0,
            );
            if (hasProjectIdsInBatch) {
              anyProjectScopedLS = true;
            }
            for (const [id, summary] of Object.entries(summaries)) {
              if (isSyntheticConversationId(id)) {
                excludedIds.add(id);
                continue;
              }

              const normalizedSummary =
                withNormalizedConversationWorkspaces(summary);

              // 1. Exclude subagents from top-level list, but attach them under their parent conversation
              const meta = (normalizedSummary.trajectoryMetadata ?? {}) as Record<string, unknown>;
              if (
                meta.parentConversationId ||
                meta.subagentSpec ||
                (typeof meta.nestingDepth === "number" && meta.nestingDepth > 0)
              ) {
                excludedIds.add(id);
                const parentId =
                  typeof meta.parentConversationId === "string"
                    ? meta.parentConversationId
                    : typeof meta.rootConversationId === "string" &&
                        meta.rootConversationId !== id
                      ? meta.rootConversationId
                      : undefined;
                if (parentId) {
                  const spec = (meta.subagentSpec ?? {}) as Record<string, unknown>;
                  const role =
                    (typeof spec.role === "string" && spec.role.trim()) ||
                    (typeof normalizedSummary.summary === "string" &&
                      normalizedSummary.summary.trim()) ||
                    (typeof spec.typeName === "string" && spec.typeName.trim()) ||
                    `子チャット ${id.slice(0, 8)}`;
                  const typeName =
                    (typeof spec.typeName === "string" && spec.typeName.trim()) ||
                    "subagent";
                  upsertChildSubagent(parentId, {
                    id,
                    role,
                    typeName,
                    status:
                      typeof normalizedSummary.status === "string"
                        ? normalizedSummary.status
                        : "CASCADE_RUN_STATUS_IDLE",
                    lastModifiedTime:
                      typeof normalizedSummary.lastModifiedTime === "string"
                        ? normalizedSummary.lastModifiedTime
                        : new Date(0).toISOString(),
                    stepCount:
                      typeof normalizedSummary.stepCount === "number"
                        ? normalizedSummary.stepCount
                        : undefined,
                  });
                }
                continue;
              }

              // 2. Exclude archived conversations: Mac app hides archived conversations
              const annotations = (normalizedSummary.annotations ?? {}) as Record<string, unknown>;
              const diskAnnotation = diskAnnotationsMap.get(id);
              if (annotations.archived === true || diskAnnotation?.archived === true) {
                excludedIds.add(id);
                continue;
              }

              // 2b. Exclude empty untitled 0-step shell cascades with no timestamp/annotation
              // (these otherwise render as blank "NaN日前 · ステップ" rows in the sidebar).
              const rawSummaryText =
                typeof normalizedSummary.summary === "string"
                  ? normalizedSummary.summary.trim()
                  : "";
              const rawStepCount =
                typeof normalizedSummary.stepCount === "number"
                  ? normalizedSummary.stepCount
                  : 0;
              const rawLastModified =
                typeof normalizedSummary.lastModifiedTime === "string"
                  ? normalizedSummary.lastModifiedTime.trim()
                  : "";
              if (
                !rawSummaryText &&
                rawStepCount === 0 &&
                !rawLastModified &&
                normalizedSummary.status !== "CASCADE_RUN_STATUS_RUNNING" &&
                !diskAnnotation
              ) {
                excludedIds.add(id);
                continue;
              }

              // 3. When Antigravity 2.0 project migration is active (hasProjectIdsInBatch),
              // exclude truly orphaned/unannotated CLI conversations that have no projectId,
              // no workspace URI, and no user title/annotation. Never exclude legitimate
              // workspace-scoped or annotated Desktop/Porta chats that lack projectId.
              const projectId = (normalizedSummary.trajectoryMetadata as any)?.projectId;
              const wsUri = getPrimaryWorkspaceUri(normalizedSummary);
              if (
                hasProjectIdsInBatch &&
                !projectId &&
                !wsUri &&
                !diskAnnotation &&
                !annotations.title
              ) {
                excludedIds.add(id);
                continue;
              }
              const assignedProjectId = userMeta.projectAssignments[id];
              const validAssignedProjectId =
                assignedProjectId && projectNameMap.has(assignedProjectId)
                  ? assignedProjectId
                  : undefined;
              const effectiveProjectId =
                validAssignedProjectId ||
                projectId ||
                (wsUri ? wsToProjectMap.get(wsUri.replace(/\/+$/, "")) : undefined);
              if (validAssignedProjectId) {
                (normalizedSummary as any).assignedProjectId = validAssignedProjectId;
              }
              if (effectiveProjectId) {
                const projectName = projectNameMap.get(effectiveProjectId);
                if (projectName) {
                  (normalizedSummary as any).projectName = projectName;
                }
              }

              const pinnedOverride = userMeta.pinnedOverrides[id];
              if (typeof pinnedOverride === "boolean") {
                normalizedSummary.annotations = {
                  ...annotations,
                  pinned: pinnedOverride,
                };
              } else if (diskAnnotation?.pinned !== undefined) {
                normalizedSummary.annotations = {
                  ...annotations,
                  pinned: diskAnnotation.pinned,
                };
              }

              if (wsUri) {
                conversationAffinity.set(id, uriToWorkspaceId(wsUri));
              }

              // Skip conversations whose workspace isn't served by any scoped
              // running LS. Antigravity 2.x exposes a hub LS with no
              // workspaceId; in that mode GetWorkspaceInfos has no
              // workspaceInfos, but GetAllCascadeTrajectories still contains
              // conversation workspace metadata. Such unscoped LS results must
              // pass through.
              if (
                inst.workspaceId &&
                wsUri &&
                !knownWsIds.has(normalizeWorkspaceId(uriToWorkspaceId(wsUri)))
              )
                continue;

              // NOTE: We intentionally do NOT inject the LS's workspace URI
              // into conversations that lack one. With warm-up loading .pb
              // files onto all LSes, the loading LS is not necessarily the
              // owner. Instead, we rely on the .pb itself containing the
              // correct workspace metadata — once warm-up loads it, the LS
              // returns it with genuine metadata on the next poll cycle.

              const diskTitle = diskAnnotation?.title;
              const resolvedTitle = await resolveSmartConversationTitle(
                id,
                diskTitle,
                typeof normalizedSummary.summary === "string"
                  ? normalizedSummary.summary
                  : undefined,
              );
              if (resolvedTitle) {
                normalizedSummary.summary = resolvedTitle;
              }

              const existing = merged[id];
              const newCount = (normalizedSummary.stepCount as number) ?? 0;
              const oldCount = (existing?.stepCount as number) ?? -1;
              const newRunning =
                normalizedSummary.status === "CASCADE_RUN_STATUS_RUNNING";
              const oldRunning =
                existing?.status === "CASCADE_RUN_STATUS_RUNNING";
              const newerMtime =
                existing &&
                newCount === oldCount &&
                parseConversationTime(normalizedSummary.lastModifiedTime) >
                parseConversationTime(existing.lastModifiedTime);
              if (
                !existing ||
                (newRunning && !oldRunning) ||
                (newRunning === oldRunning && (newCount > oldCount || newerMtime))
              ) {
                merged[id] = normalizedSummary;
              }
            }
          } catch {
            // Skip unreachable instances
          }
        }),
      );

      for (const excludedId of excludedIds) {
        delete merged[excludedId];
      }

      // Update affinity cache from merged results
      for (const [id, summary] of Object.entries(merged)) {
        const wsUri = getPrimaryWorkspaceUri(summary);
        if (wsUri) {
          conversationAffinity.set(id, uriToWorkspaceId(wsUri));
        }
        // NOTE: We intentionally do NOT learn affinity from the LS that returned
        // the summary when the conversation has no workspace metadata. With warm-up,
        // the owning LS is not necessarily the one that returned the summary.
        // Affinity is only learned from genuine workspace metadata in the
        // conversation itself — either from the .pb or from the LS that
        // originally created it.
      }

      // Also scan disk for conversations in the app-data tree used by the
      // running LS instances.
      const targetDirs = targetApp
        ? [targetApp]
        : instances.map((inst) => inst.appDataDir);
      const diskConversationDirs = conversationDirsForAppDataDirs(targetDirs);
      const diskIds = await scanDiskConversations(
        diskConversationDirs.length > 0 ? diskConversationDirs : undefined,
      );

      // Rank LS and disk-only conversations together before applying the cap.
      const candidates: ConversationCandidate[] = [];

      for (const [id, summary] of Object.entries(merged)) {
        candidates.push({
          id,
          modifiedAt: parseConversationTime(summary.lastModifiedTime),
          summary,
        });
      }

      const diskOnlyCandidatesToInspect = diskIds.filter(
        (diskId) =>
          !excludedIds.has(diskId.id) &&
          !isSyntheticConversationId(diskId.id) &&
          !merged[diskId.id],
      );

      const DISK_BATCH_CONCURRENCY = 16;
      for (let i = 0; i < diskOnlyCandidatesToInspect.length; i += DISK_BATCH_CONCURRENCY) {
        const batch = diskOnlyCandidatesToInspect.slice(i, i + DISK_BATCH_CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(async (diskId): Promise<ConversationCandidate | null> => {
            const diskAnnotation = diskAnnotationsMap.get(diskId.id);
            // Skip archived conversations on disk
            if (diskAnnotation?.archived === true) {
              return null;
            }
            // Skip unannotated subagent/orphaned .db files on disk both in project-scoped mode
            // and right after LS restarts before any projectId conversation is loaded into RAM.
            if (!diskAnnotation) {
              if (anyProjectScopedLS || (await isSubagentDiskConversation(diskId.id))) {
                return null;
              }
            }

            let injectedWorkspaces: { workspaceFolderAbsoluteUri: string }[] = [];
            const wsId = conversationAffinity.get(diskId.id);
            if (wsId && wsId.startsWith("file_")) {
              const matchedUri = [...wsToProjectMap.keys()].find(
                (u) => normalizeWorkspaceId(uriToWorkspaceId(u)) === normalizeWorkspaceId(wsId),
              );
              const uri =
                matchedUri ?? wsId.replace(/^file_/, "file:///").replace(/_/g, "/");
              injectedWorkspaces = [{ workspaceFolderAbsoluteUri: uri }];
            }

            const assignedDiskProjectId = userMeta.projectAssignments[diskId.id];
            const validAssignedDiskProjectId =
              assignedDiskProjectId && projectNameMap.has(assignedDiskProjectId)
                ? assignedDiskProjectId
                : undefined;
            const resolvedDiskProjectId =
              validAssignedDiskProjectId ||
              (injectedWorkspaces[0]?.workspaceFolderAbsoluteUri
                ? wsToProjectMap.get(
                    injectedWorkspaces[0].workspaceFolderAbsoluteUri.replace(/\/+$/, ""),
                  )
                : undefined);
            const resolvedDiskProjectName = resolvedDiskProjectId
              ? projectNameMap.get(resolvedDiskProjectId)
              : undefined;

            const diskTitle = diskAnnotation?.title;
            const resolvedDiskTitle = await resolveSmartConversationTitle(
              diskId.id,
              diskTitle,
              undefined,
            );
            const diskPinnedOverride = userMeta.pinnedOverrides[diskId.id];
            const effectiveDiskPinned =
              typeof diskPinnedOverride === "boolean"
                ? diskPinnedOverride
                : diskAnnotation?.pinned;

            return {
              id: diskId.id,
              modifiedAt: parseConversationTime(diskId.mtime),
              summary: {
                summary: resolvedDiskTitle || diskId.id.slice(0, 8) + "…",
                stepCount: 0,
                status: "CASCADE_RUN_STATUS_UNLOADED",
                lastModifiedTime: diskId.mtime,
                createdTime: diskId.mtime,
                trajectoryId: "",
                workspaces: injectedWorkspaces,
                ...(validAssignedDiskProjectId
                  ? { assignedProjectId: validAssignedDiskProjectId }
                  : {}),
                ...(resolvedDiskProjectName ? { projectName: resolvedDiskProjectName } : {}),
                ...(effectiveDiskPinned !== undefined
                  ? { annotations: { pinned: effectiveDiskPinned } }
                  : {}),
                _diskOnly: true,
              },
            };
          }),
        );
        for (const candidate of batchResults) {
          if (candidate) candidates.push(candidate);
        }
      }

      candidates.sort(compareConversationCandidates);

      const finalMerged: Record<string, Record<string, unknown>> = {};
      const diskOnlyIds: string[] = [];

      const activeAppDirs = targetApp
        ? [targetApp]
        : (["antigravity", "antigravity-ide", "antigravity-cli"] as const);

      const topCandidates = candidates.slice(0, MAX_TOTAL_CONVERSATIONS);
      const [diskChildrenList, diskTaskSummaries] = await Promise.all([
        Promise.all(
          topCandidates.map((candidate) =>
            getChildSubagentsFromDisk(candidate.id, activeAppDirs),
          ),
        ),
        Promise.all(
          topCandidates.map((candidate) =>
            getConversationTaskSummaryFromDisk(candidate.id, activeAppDirs, 5),
          ),
        ),
      ]);

      for (let idx = 0; idx < topCandidates.length; idx++) {
        const candidate = topCandidates[idx];
        for (const child of diskChildrenList[idx]) {
          upsertChildSubagent(candidate.id, child);
        }
      }

      const modelResolveInputs: Array<{
        id: string;
        stepCount: number;
        fallbackInst?: LSInstance;
        allowZeroOffset?: boolean;
        cacheKey?: string;
      }> = [];
      const seenModelIds = new Set<string>();
      for (const candidate of topCandidates) {
        seenModelIds.add(candidate.id);
        modelResolveInputs.push({
          id: candidate.id,
          stepCount:
            typeof candidate.summary.stepCount === "number"
              ? candidate.summary.stepCount
              : 0,
        });
      }
      for (const candidate of topCandidates) {
        const childMap = subagentsByParent.get(candidate.id);
        if (!childMap) continue;
        const parentInst =
          conversationInstanceAffinity.get(candidate.id) ?? instances[0];
        for (const child of childMap.values()) {
          if (seenModelIds.has(child.id)) continue;
          seenModelIds.add(child.id);
          modelResolveInputs.push({
            id: child.id,
            stepCount: typeof child.stepCount === "number" ? child.stepCount : 0,
            fallbackInst: parentInst,
            allowZeroOffset: true,
            cacheKey: `${child.stepCount ?? 0}:${child.lastModifiedTime}`,
          });
        }
      }

      const resolvedModels = await resolveConversationModels(
        modelResolveInputs,
        activeAppDirs,
        targetApp,
        true,
      );

      for (let idx = 0; idx < topCandidates.length; idx++) {
        const candidate = topCandidates[idx];
        const modelInfo = resolvedModels.get(candidate.id);
        const modelFields = modelInfo
          ? {
              ...(modelInfo.model ? { model: modelInfo.model } : {}),
              modelLabel: modelInfo.modelLabel,
              modelProvider: modelInfo.modelProvider,
            }
          : {};
        const taskSummary = diskTaskSummaries[idx];
        const taskFields =
          taskSummary && taskSummary.taskCount > 0
            ? {
                taskCount: taskSummary.taskCount,
                ...(taskSummary.activeTasks.length > 0
                  ? { activeTasks: taskSummary.activeTasks }
                  : {}),
              }
            : {};
        const childMap = subagentsByParent.get(candidate.id);
        if (childMap && childMap.size > 0) {
          const children = [...childMap.values()]
            .sort((a, b) => {
              const aRun = a.status === "CASCADE_RUN_STATUS_RUNNING";
              const bRun = b.status === "CASCADE_RUN_STATUS_RUNNING";
              if (aRun !== bRun) return aRun ? -1 : 1;
              return (
                parseConversationTime(b.lastModifiedTime) -
                parseConversationTime(a.lastModifiedTime)
              );
            })
            .map((child) => {
              const childModel = resolvedModels.get(child.id);
              return childModel
                ? {
                    ...child,
                    ...(childModel.model ? { model: childModel.model } : {}),
                    modelLabel: childModel.modelLabel,
                    modelProvider: childModel.modelProvider,
                  }
                : child;
            });
          const hasRunningSubagent = children.some(
            (child) => child.status === "CASCADE_RUN_STATUS_RUNNING",
          );
          finalMerged[candidate.id] = {
            ...candidate.summary,
            ...modelFields,
            ...taskFields,
            subagents: children,
            ...(hasRunningSubagent ? { hasRunningSubagent: true } : {}),
          };
        } else {
          finalMerged[candidate.id] = {
            ...candidate.summary,
            ...modelFields,
            ...taskFields,
          };
        }
        if (candidate.summary._diskOnly) {
          diskOnlyIds.push(candidate.id);
        }
      }

      // Background warm-up: touch disk-only conversations so each LS loads
      // them from .pb files. Once loaded, GetAllCascadeTrajectories returns
      // them with proper workspace metadata on the next poll cycle.
      if (diskOnlyIds.length > 0 && instances.length > 0) {
        warmUpDiskConversations(diskOnlyIds, instances);
      }

      return c.json({ trajectorySummaries: finalMerged });
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  app.get("/api/conversations/archived", async (c) => {
    try {
      const targetApp = extractTargetAppDataDir(c);
      const projectNameMap = await getProjectNameMap();
      const instances = await discovery.getInstances(false, targetApp);
      const merged: Record<string, Record<string, unknown>> = {};

      await Promise.allSettled(
        instances.map(async (inst) => {
          try {
            const data = await rpc.call<{
              trajectorySummaries: Record<string, Record<string, unknown>>;
            }>("GetAllCascadeTrajectories", {}, inst);
            const summaries = data.trajectorySummaries ?? {};
            for (const [id, summary] of Object.entries(summaries)) {
              const normalizedSummary =
                withNormalizedConversationWorkspaces(summary);
              const meta = (normalizedSummary.trajectoryMetadata ?? {}) as Record<
                string,
                unknown
              >;
              if (
                meta.parentConversationId ||
                meta.subagentSpec ||
                (typeof meta.nestingDepth === "number" && meta.nestingDepth > 0)
              ) {
                continue;
              }

              const annotations = (normalizedSummary.annotations ?? {}) as Record<
                string,
                unknown
              >;
              const diskAnnotation = await getConversationAnnotationsFromDisk(id);
              const isArchivedItem =
                annotations.archived === true || diskAnnotation?.archived === true;
              if (!isArchivedItem) {
                continue;
              }

              const projectId = (normalizedSummary.trajectoryMetadata as any)
                ?.projectId;
              if (projectId) {
                const projectName = projectNameMap.get(projectId);
                if (projectName) {
                  (normalizedSummary as any).projectName = projectName;
                }
              }

              const diskTitle =
                diskAnnotation?.title ?? (await getConversationTitleFromDisk(id));
              const resolvedArchTitle = await resolveSmartConversationTitle(
                id,
                diskTitle,
                typeof normalizedSummary.summary === "string"
                  ? normalizedSummary.summary
                  : undefined,
              );
              if (resolvedArchTitle) {
                normalizedSummary.summary = resolvedArchTitle;
              }
              normalizedSummary.annotations = {
                ...annotations,
                archived: true,
              };
              if (diskAnnotation?.archivedAtSeconds) {
                normalizedSummary.lastModifiedTime = new Date(
                  diskAnnotation.archivedAtSeconds * 1000,
                ).toISOString();
              }

              const existing = merged[id];
              const newCount = (normalizedSummary.stepCount as number) ?? 0;
              const oldCount = (existing?.stepCount as number) ?? -1;
              if (!existing || newCount > oldCount) {
                merged[id] = normalizedSummary;
              }
            }
          } catch {
            // Skip unreachable instances
          }
        }),
      );

      const appDirs = targetApp
        ? [targetApp]
        : (["antigravity", "antigravity-ide", "antigravity-cli"] as const);
      const diskArchived = await scanArchivedDiskConversations(appDirs);
      for (const item of diskArchived) {
        if (!merged[item.id]) {
          let injectedWorkspaces: { workspaceFolderAbsoluteUri: string }[] = [];
          const wsId = conversationAffinity.get(item.id);
          if (wsId && wsId.startsWith("file_")) {
            const uri = wsId.replace(/^file_/, "file:///").replace(/_/g, "/");
            injectedWorkspaces = [{ workspaceFolderAbsoluteUri: uri }];
          }
          const resolvedItemTitle = await resolveSmartConversationTitle(
            item.id,
            item.title,
            undefined,
          );
          merged[item.id] = {
            summary: resolvedItemTitle || item.id.slice(0, 8) + "…",
            stepCount: 0,
            status: "CASCADE_RUN_STATUS_UNLOADED",
            lastModifiedTime: item.lastModifiedTime,
            createdTime: item.lastModifiedTime,
            trajectoryId: "",
            workspaces: injectedWorkspaces,
            annotations: { archived: true },
          };
        }
      }

      const sortedEntries = Object.entries(merged).sort(
        ([, a], [, b]) =>
          parseConversationTime(b.lastModifiedTime) -
          parseConversationTime(a.lastModifiedTime),
      );

      const archivedModels = await resolveConversationModels(
        sortedEntries.slice(0, MAX_TOTAL_CONVERSATIONS).map(([id, summary]) => ({
          id,
          stepCount: typeof summary.stepCount === "number" ? summary.stepCount : 0,
        })),
        appDirs,
        targetApp,
        false,
      );

      const enrichedArchived = sortedEntries.map(([id, summary]) => {
        const modelInfo = archivedModels.get(id);
        if (!modelInfo) return [id, summary] as const;
        return [
          id,
          {
            ...summary,
            ...(modelInfo.model ? { model: modelInfo.model } : {}),
            modelLabel: modelInfo.modelLabel,
            modelProvider: modelInfo.modelProvider,
          },
        ] as const;
      });

      return c.json({
        trajectorySummaries: Object.fromEntries(enrichedArchived),
      });
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  app.get("/api/conversations/:id", async (c) => {
    const id = c.req.param("id");
    const targetApp = extractTargetAppDataDir(c);
    try {
      const data = targetApp
        ? await rpcForConversation(
          "GetCascadeTrajectory",
          id,
          { cascadeId: id },
          undefined,
          true,
          targetApp,
        )
        : await rpcForConversation("GetCascadeTrajectory", id, {
          cascadeId: id,
        }, undefined, true);
      return c.json(data);
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  app.get("/api/conversations/:id/steps", async (c) => {
    const id = c.req.param("id");
    const targetApp = extractTargetAppDataDir(c);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);
    const limitParam = c.req.query("limit");
    let limit = limitParam ? parseInt(limitParam, 10) : undefined;
    if (limit !== undefined && (isNaN(limit) || limit <= 0)) {
      limit = 100;
    }
    if (limit !== undefined) {
      limit = Math.min(limit, MAX_STEPS_LIMIT);
    }

    try {
      let resolvedOffset = offset;
      let stepCount: number | undefined;
      let pinnedInstance: LSInstance | undefined;
      let stepsArray: unknown[] = [];

      if (c.req.query("tail")) {
        // readOnly=true: this endpoint only reads steps; the pinned instance
        // is NOT reused for mutations, so try-all fallback is safe and
        // necessary for disk-only conversations that no LS has in memory yet.
        const sc = targetApp
          ? await getStepCount(id, undefined, true, targetApp)
          : await getStepCount(id, undefined, true);
        pinnedInstance = sc.instance;
        if (sc.count > 0) {
          stepCount = sc.count;
          let tailSize = parseInt(c.req.query("tail")!, 10);
          if (isNaN(tailSize) || tailSize <= 0) {
            tailSize = 100;
          }
          tailSize = Math.min(tailSize, MAX_STEPS_LIMIT);
          resolvedOffset = Math.max(0, stepCount - tailSize);
        }
      }

      // We need to fetch until we get what we came for, or we run out of steps.
      let currentOffset = resolvedOffset;
      let targetCount =
        limit ?? (stepCount ? stepCount - resolvedOffset : 100);
      targetCount = Math.min(targetCount, MAX_STEPS_LIMIT);
      let consecutiveSkips = 0;

      const pushPlaceholders = (count: number, reason: string) => {
        const remainingTarget = targetCount - stepsArray.length;
        const remainingSkips = MAX_SKIP - consecutiveSkips;
        const placeholderCount = Math.max(
          0,
          Math.min(count, remainingTarget, remainingSkips),
        );
        for (let s = 0; s < placeholderCount; s++) {
          stepsArray.push(placeholderStep(reason));
        }
      };

      while (stepsArray.length < targetCount) {
        try {
          const data = targetApp
            ? await rpcForConversation<{ steps?: unknown[] }>(
              "GetCascadeTrajectorySteps",
              id,
              {
                cascadeId: id,
                stepOffset: currentOffset,
              },
              pinnedInstance,
              true,
              targetApp,
            )
            : await rpcForConversation<{ steps?: unknown[] }>(
              "GetCascadeTrajectorySteps",
              id,
              {
                cascadeId: id,
                stepOffset: currentOffset,
              },
              pinnedInstance,
              true,
            );

          const chunk = data.steps ?? [];
          if (chunk.length === 0) break;

          stepsArray.push(...chunk);
          currentOffset += chunk.length;
          consecutiveSkips = 0;
        } catch (fetchErr) {
          const badOffset = oversizedStepOffset(fetchErr);
          if (badOffset >= 0) {
            // Known oversized step — skip directly
            const skipCount = badOffset - currentOffset + 1;
            pushPlaceholders(
              skipCount,
              "Language Server: step exceeds 4MB protobuf limit",
            );
            currentOffset = badOffset + 1;
            consecutiveSkips += skipCount;
            if (consecutiveSkips >= MAX_SKIP) break;
          } else if (isRecoverableStepError(fetchErr)) {
            // Corrupted batch (e.g. invalid UTF-8) — binary search forward
            if (stepCount === undefined) {
              const sc = await getStepCount(
                id,
                undefined,
                true,
                targetApp,
              );
              stepCount = sc.count;
              pinnedInstance ??= sc.instance;
            }
            const nextValid = await findNextValidOffset(
              id,
              currentOffset + 1,
              stepCount,
              pinnedInstance,
            );
            const skipCount = nextValid - currentOffset;
            pushPlaceholders(
              skipCount,
              "Language Server: invalid UTF-8 in step data",
            );
            console.log(
              `Skipping corrupted range [${currentOffset}, ${nextValid - 1}] (${skipCount} steps)`,
            );
            currentOffset = nextValid;
            consecutiveSkips += skipCount;
            if (consecutiveSkips >= MAX_SKIP) break;
          } else {
            throw fetchErr;
          }
        }
      }

      // If we overfetched because of chunks, slice it down to the exact limit requested
      if (stepsArray.length > targetCount) {
        stepsArray = stepsArray.slice(0, targetCount);
      }

      return c.json({
        steps: sanitizeStepsForClient(
          messageTracker.annotateSteps(id, resolvedOffset, stepsArray),
        ),
        offset: resolvedOffset,
        ...(stepCount !== undefined ? { stepCount } : {}),
      });
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  app.post("/api/conversations", async (c) => {
    try {
      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<
        string,
        unknown
      >;
      const metadata = await getMetadata(!!body.fileAccessGranted);

      const bodyWorkspaceUris = requestedWorkspaceUris(body);
      let workspaceUri: string | undefined =
        typeof body.workspaceFolderAbsoluteUri === "string"
          ? body.workspaceFolderAbsoluteUri
          : bodyWorkspaceUris[0];
      const targetApp = extractTargetAppDataDir(c);
      const instances = await discovery.getInstances(false, targetApp);

      if (instances.length === 0) {
        return c.json(
          {
            error: targetApp
              ? `No running Language Server found for ${targetApp}.`
              : "No running Language Server found.",
          },
          503,
        );
      }

      // Resolve which LS instance to use based on workspace URI
      let targetInstance: LSInstance | undefined;
      if (workspaceUri) {
        const wsId = normalizeWorkspaceId(uriToWorkspaceId(workspaceUri));
        targetInstance =
          instances.find(
            (i) => i.workspaceId && normalizeWorkspaceId(i.workspaceId) === wsId,
          ) ?? undefined;
        if (!targetInstance) {
          const unscoped = instances.filter((i) => !i.workspaceId);
          // Antigravity 2.x hub instances can serve any workspace; prefer healthy hubs that actually have models.
          targetInstance =
            unscoped.find((i) => i.modelCount === undefined || i.modelCount > 0) ??
            unscoped[0];
        }

        // Workspace was explicitly requested but no LS owns it — fail clearly
        if (!targetInstance) {
          return c.json(
            {
              error:
                "No Language Server found for this workspace. Open the project in Antigravity first.",
              detail: workspaceUri,
            },
            503,
          );
        }
      } else {
        // No workspace specified — pick first healthy available LS.
        // Only auto-inject a single workspace URI when no explicit projectId
        // (such as "default-cli-project") was requested.
        targetInstance =
          instances.find((i) => i.modelCount === undefined || i.modelCount > 0) ??
          instances[0];
        if (!body.projectId) {
          workspaceUri = await discoverSingleWorkspaceUri(instances);
        }
      }

      const startWorkspaceUris =
        bodyWorkspaceUris.length > 0
          ? bodyWorkspaceUris
          : workspaceUri
            ? [workspaceUri]
            : [];

      const wsToProjectMap = await getWorkspaceToProjectIdMap();
      const primaryStartUri = (startWorkspaceUris[0] ?? workspaceUri)?.replace(/\/+$/, "");
      const resolvedProjectId =
        (typeof body.projectId === "string" && body.projectId) ||
        (primaryStartUri ? wsToProjectMap.get(primaryStartUri) : undefined);

      const data = await rpc.call(
        "StartCascade",
        {
          ...body,
          metadata,
          source:
            typeof body.source === "string"
              ? body.source
              : "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT",
          ...(workspaceUri ? { workspaceFolderAbsoluteUri: workspaceUri } : {}),
          ...(startWorkspaceUris.length > 0
            ? { workspaceUris: startWorkspaceUris }
            : {}),
          ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
        },
        targetInstance,
      );

      // Learn affinity immediately
      const newId = (data as Record<string, unknown>)?.cascadeId as
        | string
        | undefined;
      if (newId && workspaceUri) {
        conversationAffinity.set(newId, uriToWorkspaceId(workspaceUri));
      } else if (newId && targetInstance?.workspaceId) {
        conversationAffinity.set(newId, targetInstance.workspaceId);
      }
      if (newId && targetInstance && !targetInstance.workspaceId) {
        conversationInstanceAffinity.set(newId, targetInstance);
      }

      // Signal WS connections for this conversation to enter ACTIVE state
      if (newId) conversationSignals.emit("activate", newId);

      return c.json(data, 201);
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  app.post("/api/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    const targetApp = extractTargetAppDataDir(c);
    try {
      return await runConversationMutation(id, async () => {
        const body = await c.req.json();
        const {
          items,
          model,
          media,
          plannerType,
          clientMessageId,
          autoExecutionPolicy,
        } = body;
        const validAutoExecutionPolicy =
          typeof autoExecutionPolicy === "string" &&
          VALID_AUTO_EXECUTION_POLICIES.has(autoExecutionPolicy)
            ? autoExecutionPolicy
            : undefined;
        const metadata = await getMetadata(!!body.fileAccessGranted);
        const { count: preSendStepCount, instance: resolvedInstance } = await getStepCount(id, undefined, false, targetApp);
        let instance = resolvedInstance;

        // Guard against auxiliary model-less hubs (e.g., third-party `agy --hub` with 0 models):
        // before sending, proactively reroute to a healthy LS that has models configured so
        // messages never vanish into an unauthenticated stub hub.
        if (instance?.modelCount === 0) {
          const allInstances = await discovery.getInstances(false, targetApp);
          const healthy = allInstances.find(
            (cand) =>
              cand.pid !== instance?.pid &&
              typeof cand.modelCount === "number" &&
              cand.modelCount > 0,
          );
          if (healthy) {
            console.warn(
              `[Porta Proxy] Rerouting message for ${id.slice(0, 8)} away from model-less hub (pid=${instance.pid}) to healthy LS (pid=${healthy.pid}, models=${healthy.modelCount}).`,
            );
            conversationInstanceAffinity.delete(id);
            try {
              await rpc.call("LoadTrajectory", { cascadeId: id }, healthy);
            } catch {
              // Conversation may already be loaded or disk-backed
            }
            conversationInstanceAffinity.set(id, healthy);
            instance = healthy;
          }
        }

        const req: Record<string, unknown> = {
          metadata,
          cascadeId: id,
          items,
        };

        if (media && Array.isArray(media) && media.length > 0) {
          req.media = media;
        }

        const typeConfig =
          plannerType === "planning" ? { planning: {} } : { conversational: {} };
        const toolConfig = validAutoExecutionPolicy
          ? {
              runCommand: {
                autoCommandConfig: {
                  autoExecutionPolicy: validAutoExecutionPolicy,
                },
              },
            }
          : undefined;

        if (model || plannerType || toolConfig) {
          req.cascadeConfig = {
            plannerConfig: {
              plannerTypeConfig: typeConfig,
              ...(model ? { requestedModel: { model } } : {}),
              ...(toolConfig ? { toolConfig } : {}),
            },
          };
        }

        // Emit activate before the RPC to start 200ms polling immediately
        conversationSignals.emit("activate", id);

        const sendOnce = async (payload: Record<string, unknown>) =>
          targetApp
            ? rpcForConversation(
                "SendUserCascadeMessage",
                id,
                payload,
                instance,
                false,
                targetApp,
              )
            : rpcForConversation(
                "SendUserCascadeMessage",
                id,
                payload,
                instance,
              );

        let data: unknown;
        let usedModel: string | undefined =
          typeof model === "string" && model.trim() ? model.trim() : undefined;
        try {
          data = await sendOnce(req);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isUnknownModel =
            !!model && /unknown model key|model not found/i.test(msg);
          if (!isUnknownModel) {
            throw err;
          }

          // First, check whether we accidentally routed to an empty/unauthenticated
          // auxiliary hub (modelCount === 0) while a healthy LS with models is alive.
          const allInstances = await discovery.getInstances(false, targetApp);
          const failedPid = instance?.pid;
          const alternateHealthy = allInstances.find(
            (cand) =>
              cand.pid !== failedPid &&
              typeof cand.modelCount === "number" &&
              cand.modelCount > 0,
          );
          if (alternateHealthy && (instance?.modelCount === 0 || !instance)) {
            console.warn(
              `[Porta Proxy] Model "${model}" rejected by model-less hub (pid=${failedPid ?? "unknown"}); rerouting conversation ${id.slice(0, 8)} to healthy LS (pid=${alternateHealthy.pid}, models=${alternateHealthy.modelCount}).`,
            );
            conversationInstanceAffinity.delete(id);
            try {
              await rpc.call("LoadTrajectory", { cascadeId: id }, alternateHealthy);
            } catch {
              // Conversation may already be loaded or disk-backed; continue sending
            }
            try {
              data = await rpc.call("SendUserCascadeMessage", req, alternateHealthy);
              conversationInstanceAffinity.set(id, alternateHealthy);
              usedModel = typeof model === "string" && model.trim() ? model.trim() : undefined;
            } catch {
              // Fall through to live-default model recovery on the healthy LS
              data = undefined;
            }
          }

          if (data === undefined) {
            // Auto-recover from retired/stale client model keys (e.g., MODEL_PLACEHOLDER_M36)
            // by resolving the live LS default model and retrying once.
            let fallbackModel: string | undefined;
            const liveInst =
              alternateHealthy ??
              (instance && instance.modelCount !== 0 ? instance : undefined) ??
              allInstances[0];
            try {
              if (liveInst) {
                const status = (await rpc.call("GetUserStatus", {}, liveInst)) as {
                  userStatus?: {
                    cascadeModelConfigData?: {
                      defaultOverrideModelConfig?: { modelOrAlias?: { model?: string } };
                      clientModelConfigs?: Array<{ modelOrAlias?: { model?: string } }>;
                    };
                  };
                };
                const cfg = status?.userStatus?.cascadeModelConfigData;
                fallbackModel =
                  cfg?.defaultOverrideModelConfig?.modelOrAlias?.model ??
                  cfg?.clientModelConfigs?.[0]?.modelOrAlias?.model;
              }
            } catch {
              // Fall through to omitting requestedModel
            }

            console.warn(
              `[Porta Proxy] Retired/unknown model "${model}" rejected by LS; retrying with ${fallbackModel ? `"${fallbackModel}"` : "LS default"}`,
            );

            const retryReq: Record<string, unknown> = {
              ...req,
              cascadeConfig: {
                plannerConfig: {
                  plannerTypeConfig: typeConfig,
                  ...(fallbackModel ? { requestedModel: { model: fallbackModel } } : {}),
                  ...(toolConfig ? { toolConfig } : {}),
                },
              },
            };
            if (alternateHealthy && liveInst === alternateHealthy) {
              data = await rpc.call("SendUserCascadeMessage", retryReq, alternateHealthy);
              conversationInstanceAffinity.set(id, alternateHealthy);
            } else {
              data = await sendOnce(retryReq);
            }
            usedModel = fallbackModel ?? undefined;
          }
        }
        if (usedModel) {
          recordConversationModel(id, usedModel);
        }
        if (typeof clientMessageId === "string" && clientMessageId.length > 0) {
          messageTracker.trackPendingMessage(
            id,
            clientMessageId,
            preSendStepCount,
          );
        }
        return c.json(data);
      });
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  // ── Stop ──

  app.post("/api/conversations/:id/stop", async (c) => {
    const id = c.req.param("id");
    const targetApp = extractTargetAppDataDir(c);
    try {
      const data = targetApp
        ? await rpcForConversation(
          "CancelCascadeInvocation",
          id,
          {
            cascadeId: id,
          },
          undefined,
          false,
          targetApp,
        )
        : await rpcForConversation("CancelCascadeInvocation", id, {
          cascadeId: id,
        });
      return c.json(data);
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  // ── Delete ──

  app.delete("/api/conversations/:id", async (c) => {
    const id = c.req.param("id");
    const targetApp = extractTargetAppDataDir(c);
    try {
      return await runConversationMutation(id, async () => {
        const metadata = await getMetadata(true);
        const data = targetApp
          ? await rpcForConversation(
            "DeleteCascadeTrajectory",
            id,
            {
              metadata,
              cascadeId: id,
            },
            undefined,
            false,
            targetApp,
          )
          : await rpcForConversation("DeleteCascadeTrajectory", id, {
            metadata,
            cascadeId: id,
          });
        messageTracker.clearConversation(id);
        return c.json(data);
      });
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  // ── Revert ──

  // ── File Permission ──

  app.post("/api/conversations/:id/file-permission", async (c) => {
    const id = c.req.param("id");
    const targetApp = extractTargetAppDataDir(c);
    try {
      const body = await c.req.json();
      const { trajectoryId, stepIndex, allow, scope, absolutePathUri } = body;

      if (
        !trajectoryId ||
        stepIndex === undefined ||
        absolutePathUri === undefined
      ) {
        return c.json(
          {
            error:
              "Missing required fields: trajectoryId, stepIndex, absolutePathUri",
          },
          400,
        );
      }

      // Build HandleCascadeUserInteraction request with exact protobuf structure.
      // CRITICAL: top-level field is "interaction" (not "userInteraction"),
      // and it MUST include trajectoryId + stepIndex alongside filePermission.
      const payload = {
        cascadeId: id,
        interaction: {
          trajectoryId,
          stepIndex: Number(stepIndex),
          filePermission: {
            allow: !!allow,
            scope: Number(scope) || 0,
            absolutePathUri,
          },
        },
      };
      const data = targetApp
        ? await rpcForConversation(
          "HandleCascadeUserInteraction",
          id,
          payload,
          undefined,
          false,
          targetApp,
        )
        : await rpcForConversation(
          "HandleCascadeUserInteraction",
          id,
          payload,
        );

      // Permission approval unblocks subsequent WAITING steps — wake WS polling
      conversationSignals.emit("activate", id);

      return c.json(data);
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  // ── Generic permission (commands, web access, and tools) ──

  app.post("/api/conversations/:id/command-action", async (c) => {
    const id = c.req.param("id");
    const targetApp = extractTargetAppDataDir(c);
    try {
      const body = await c.req.json();
      const { trajectoryId, stepIndex, approved } = body;

      if (!trajectoryId || stepIndex === undefined) {
        return c.json(
          {
            error:
              "Missing required fields: trajectoryId, stepIndex",
          },
          400,
        );
      }

      // requestedInteraction.permission always expects interaction.permission,
      // including web/tool access requests. Keep the existing endpoint name
      // for compatibility with command and file permission clients.
      const payload = {
        cascadeId: id,
        interaction: {
          trajectoryId,
          stepIndex: Number(stepIndex),
          permission: {
            allow: !!approved,
          },
        },
      };
      const data = targetApp
        ? await rpcForConversation(
          "HandleCascadeUserInteraction",
          id,
          payload,
          undefined,
          false,
          targetApp,
        )
        : await rpcForConversation(
          "HandleCascadeUserInteraction",
          id,
          payload,
        );

      // Command approval/rejection unblocks the agent — wake WS polling
      conversationSignals.emit("activate", id);

      return c.json(data);
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  // ── Ask Question (Antigravity choice prompts) ──

  app.post("/api/conversations/:id/ask-question", async (c) => {
    const id = c.req.param("id");
    const targetApp = extractTargetAppDataDir(c);
    try {
      const body = await c.req.json();
      const { trajectoryId, stepIndex, responses, cancelled } = body;

      if (!trajectoryId || stepIndex === undefined) {
        return c.json(
          {
            error: "Missing required fields: trajectoryId, stepIndex",
          },
          400,
        );
      }

      const payload = {
        cascadeId: id,
        interaction: {
          trajectoryId,
          stepIndex: Number(stepIndex),
          askQuestion: {
            responses: Array.isArray(responses) ? responses : [],
            cancelled: !!cancelled,
          },
        },
      };
      const data = targetApp
        ? await rpcForConversation(
          "HandleCascadeUserInteraction",
          id,
          payload,
          undefined,
          false,
          targetApp,
        )
        : await rpcForConversation(
          "HandleCascadeUserInteraction",
          id,
          payload,
        );

      conversationSignals.emit("activate", id);

      return c.json(data);
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  app.post("/api/conversations/:id/revert", async (c) => {
    const id = c.req.param("id");
    const targetApp = extractTargetAppDataDir(c);
    try {
      return await runConversationMutation(id, async () => {
        const body = await c.req.json();
        const metadata = await getMetadata(true);

        const req: Record<string, unknown> = {
          cascadeId: id,
          stepIndex: body.stepIndex,
          metadata,
        };

        const data = targetApp
          ? await rpcForConversation(
            "RevertToCascadeStep",
            id,
            req,
            undefined,
            false,
            targetApp,
          )
          : await rpcForConversation("RevertToCascadeStep", id, req);
        messageTracker.clearConversation(id);
        conversationSignals.emit("activate", id);
        return c.json(data);
      });
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  app.patch("/api/conversations/:id/title", async (c) => {
    const id = c.req.param("id");
    const targetApp = extractTargetAppDataDir(c);
    let body: { title?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const title = body.title?.trim();
    if (!title) {
      return c.json({ error: "Title cannot be empty" }, 400);
    }
    try {
      await rpcForConversation(
        "UpdateConversationAnnotations",
        id,
        {
          cascadeId: id,
          annotations: { title },
          mergeAnnotations: true,
        },
        undefined,
        false,
        targetApp,
      );
    } catch {
      // Fallback to disk-only if LS does not have conversation loaded
    }
    const ok = await setConversationTitleOnDisk(id, title);
    if (!ok) {
      return c.json({ error: "Failed to set title on disk" }, 500);
    }
    if (c.req.header("x-porta-title-source") !== "auto") {
      await saveManualTitleLock(id, title);
    }
    conversationSignals.emit("activate", id);
    return c.json({ ok: true, id, title });
  });

  app.patch("/api/conversations/:id/annotations", async (c) => {
    const id = c.req.param("id");
    const targetApp = extractTargetAppDataDir(c);
    let body: { title?: string; archived?: boolean; pinned?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const patch: { title?: string; archived?: boolean; pinned?: boolean } = {};
    if (body.title !== undefined) {
      const t = body.title.trim();
      if (!t) {
        return c.json({ error: "Title cannot be empty" }, 400);
      }
      patch.title = t;
    }
    if (typeof body.archived === "boolean") {
      patch.archived = body.archived;
    }
    if (typeof body.pinned === "boolean") {
      patch.pinned = body.pinned;
    }

    if (Object.keys(patch).length === 0) {
      return c.json({ error: "No valid annotation fields provided" }, 400);
    }

    const existingDiskMeta = await getConversationAnnotationsFromDisk(
      id,
      targetApp ? [targetApp] : undefined,
    );

    if (patch.pinned !== undefined) {
      await setPinnedOverride(id, patch.pinned);
    }

    try {
      const rpcAnnotations: Record<string, unknown> = { ...patch };
      if (patch.archived !== undefined) {
        rpcAnnotations.archivalStatusTimestamp = new Date().toISOString();
      }
      // proto3 の仕様上、mergeAnnotations:true で pinned:false を送るとデフォルト値として無視され
      // LS メモリ上の pinned:true が残って復活してしまう。pinned:false 指定時は既存項目を引き継ぎ
      // mergeAnnotations:false で明示的に置換して LS 側からも確実にクリアする。
      let mergeAnnotations = true;
      if (patch.pinned === false) {
        mergeAnnotations = false;
        delete rpcAnnotations.pinned;
        if (rpcAnnotations.title === undefined && existingDiskMeta?.title) {
          rpcAnnotations.title = existingDiskMeta.title;
        }
        if (
          rpcAnnotations.archived === undefined &&
          existingDiskMeta?.archived === true
        ) {
          rpcAnnotations.archived = true;
        }
      }
      await rpcForConversation(
        "UpdateConversationAnnotations",
        id,
        {
          cascadeId: id,
          annotations: rpcAnnotations,
          mergeAnnotations,
        },
        undefined,
        false,
        targetApp,
      );
    } catch {
      // Fallback to disk-only if LS does not have conversation loaded
    }

    const ok = await setConversationAnnotationsOnDisk(
      id,
      patch,
      targetApp ? [targetApp] : undefined,
    );
    if (!ok) {
      return c.json({ error: "Failed to update annotations on disk" }, 500);
    }
    if (patch.title && c.req.header("x-porta-title-source") !== "auto") {
      await saveManualTitleLock(id, patch.title);
    }
    if (patch.archived !== undefined) {
      await syncIntentionalArchiveRegistry(
        id,
        patch.archived,
        patch.title ?? existingDiskMeta?.title,
      );
    }
    conversationSignals.emit("activate", id);
    return c.json({ ok: true, id, ...patch });
  });

  app.patch("/api/conversations/:id/project", async (c) => {
    const id = c.req.param("id");
    let body: { projectId?: string | null };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const rawProjectId =
      typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!rawProjectId) {
      await setProjectAssignment(id, null);
      conversationSignals.emit("activate", id);
      return c.json({ ok: true, id, projectId: null, projectName: null });
    }

    const projectNameMap = await getProjectNameMap();
    const projectName = projectNameMap.get(rawProjectId);
    if (!projectName) {
      return c.json({ error: "指定されたプロジェクトが見つかりません" }, 404);
    }

    await setProjectAssignment(id, rawProjectId);
    conversationSignals.emit("activate", id);
    return c.json({ ok: true, id, projectId: rawProjectId, projectName });
  });

  app.get("/api/conversations/:id/agents", async (c) => {
    const id = c.req.param("id");
    const targetApp = extractTargetAppDataDir(c);
    try {
      const activeAppDirs = targetApp
        ? [targetApp]
        : (["antigravity", "antigravity-ide", "antigravity-cli"] as const);

      const [diskSubagents, tasks, instances] = await Promise.all([
        getDetailedSubagentsFromDisk(id, activeAppDirs),
        getConversationBackgroundTasksFromDisk(id, activeAppDirs, 25),
        discovery.getInstances(false, targetApp).catch(() => []),
      ]);

      const liveSubagentMap = new Map<
        string,
        {
          status: string;
          stepCount?: number;
          lastModifiedTime?: string;
          summary?: string;
          role?: string;
          typeName?: string;
        }
      >();

      await Promise.allSettled(
        instances.map(async (inst) => {
          try {
            const data = await rpc.call<{
              trajectorySummaries?: Record<string, Record<string, unknown>>;
            }>("GetAllCascadeTrajectories", {}, inst);
            for (const [cid, summary] of Object.entries(
              data.trajectorySummaries ?? {},
            )) {
              const meta = summary.trajectoryMetadata as
                | {
                    parentConversationId?: string;
                    subagentSpec?: { role?: string; typeName?: string };
                  }
                | undefined;
              if (
                meta?.parentConversationId === id ||
                diskSubagents.some((d) => d.id === cid)
              ) {
                const status =
                  typeof summary.status === "string"
                    ? summary.status
                    : "CASCADE_RUN_STATUS_IDLE";
                const prev = liveSubagentMap.get(cid);
                const prevRun = prev?.status === "CASCADE_RUN_STATUS_RUNNING";
                const nextRun = status === "CASCADE_RUN_STATUS_RUNNING";
                if (!prev || (nextRun && !prevRun)) {
                  liveSubagentMap.set(cid, {
                    status,
                    stepCount:
                      typeof summary.stepCount === "number"
                        ? summary.stepCount
                        : undefined,
                    lastModifiedTime:
                      typeof summary.lastModifiedTime === "string"
                        ? summary.lastModifiedTime
                        : undefined,
                    summary:
                      typeof summary.summary === "string"
                        ? summary.summary
                        : undefined,
                    role: meta?.subagentSpec?.role,
                    typeName: meta?.subagentSpec?.typeName,
                  });
                }
              }
            }
          } catch {
            // Skip unreachable LS
          }
        }),
      );

      const mergedMap = new Map<
        string,
        {
          id: string;
          role: string;
          typeName: string;
          state: string;
          status: string;
          running: boolean;
          stepCount?: number;
          spawnStepIndex?: number;
          lastModifiedTime: string;
        }
      >();

      for (const disk of diskSubagents) {
        const live = liveSubagentMap.get(disk.id);
        const status = live?.status ?? "CASCADE_RUN_STATUS_IDLE";
        mergedMap.set(disk.id, {
          id: disk.id,
          role: live?.role?.trim() || disk.role,
          typeName: live?.typeName?.trim() || disk.typeName,
          state: disk.state,
          status,
          running: status === "CASCADE_RUN_STATUS_RUNNING",
          stepCount: live?.stepCount,
          spawnStepIndex: disk.spawnStepIndex,
          lastModifiedTime: live?.lastModifiedTime || disk.lastModifiedTime,
        });
      }

      for (const [cid, live] of liveSubagentMap.entries()) {
        if (mergedMap.has(cid)) continue;
        mergedMap.set(cid, {
          id: cid,
          role: live.role?.trim() || live.summary?.trim() || `エージェント ${cid.slice(0, 8)}`,
          typeName: live.typeName?.trim() || "subagent",
          state: live.status === "CASCADE_RUN_STATUS_RUNNING" ? "SUBAGENT_STATE_ALIVE" : "SUBAGENT_STATE_IDLE",
          status: live.status,
          running: live.status === "CASCADE_RUN_STATUS_RUNNING",
          stepCount: live.stepCount,
          lastModifiedTime: live.lastModifiedTime || new Date().toISOString(),
        });
      }

      const subagents = [...mergedMap.values()].sort((a, b) => {
        if (a.running !== b.running) return a.running ? -1 : 1;
        return b.lastModifiedTime.localeCompare(a.lastModifiedTime);
      });

      const runningSubagents = subagents.filter((s) => s.running).length;
      const activeTasks = tasks.filter((t) => t.isActive).length;

      return c.json({
        conversationId: id,
        subagents,
        tasks,
        counts: {
          subagents: subagents.length,
          runningSubagents,
          tasks: tasks.length,
          activeTasks,
        },
      });
    } catch (err) {
      return handleRPCError(c, err);
    }
  });
}
