/**
 * Shared metadata and disk-scanning utilities for the proxy.
 */

import { readdir, stat, readFile, writeFile, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

export function resolveGeminiBaseDir(): string {
  if (process.env.PORTA_GEMINI_DIR) return process.env.PORTA_GEMINI_DIR;
  if (process.env.VITEST) {
    return join(tmpdir(), `porta-vitest-gemini-${process.pid}`);
  }
  return join(homedir(), ".gemini");
}

export function isSyntheticConversationId(id: string): boolean {
  return (
    !id ||
    /^test-title-conv-/.test(id) ||
    /^0+-0+/.test(id) ||
    /^(\d)\1{7}-/.test(id)
  );
}

export interface ConversationWorkspaceMetadata {
  workspaceFolderAbsoluteUri?: string;
  gitRootAbsoluteUri?: string;
  repository?: {
    computedName?: string;
    gitOriginUrl?: string;
  };
  branchName?: string;
}

const KNOWN_APP_DATA_DIRS = ["antigravity", "antigravity-ide", "antigravity-cli"] as const;

function conversationDirForAppDataDir(appDataDir: string): string {
  return join(homedir(), ".gemini", appDataDir, "conversations");
}

const CONVERSATIONS_DIRS = KNOWN_APP_DATA_DIRS.map(conversationDirForAppDataDir);

const CONVERSATION_EXTENSIONS = [".pb", ".db"] as const;

function conversationIdFromFilename(file: string): string | undefined {
  const extension = CONVERSATION_EXTENSIONS.find((ext) => file.endsWith(ext));
  return extension ? file.slice(0, -extension.length) : undefined;
}

/**
 * Build the metadata object that the LS requires on write RPCs.
 * Mirrors what the VS Code extension sends via MetadataProvider.
 */
export async function getMetadata(
  fileAccessGranted = false,
): Promise<Record<string, unknown>> {
  const meta: Record<string, unknown> = {
    ideName: "porta",
    ideVersion: "0.1.0",
    extensionVersion: "0.1.0",
  };
  if (fileAccessGranted) {
    meta.allowFileAccess = true;
    meta.allWorkspaceTrustGranted = true;
  }
  return meta;
}

/** Scan disk for conversation files not loaded in memory */
export async function scanDiskConversations(
  conversationsDirs: string | string[] = CONVERSATIONS_DIRS,
): Promise<
  { id: string; mtime: string }[]
> {
  const dirs = Array.isArray(conversationsDirs)
    ? conversationsDirs
    : [conversationsDirs];
  const results = new Map<string, { id: string; mtime: string }>();
  const STAT_CONCURRENCY = 24;

  for (const conversationsDir of dirs) {
    let files: string[];
    try {
      files = await readdir(conversationsDir);
    } catch {
      // Conversation dir missing or unreadable
      continue;
    }

    const targets: Array<{ id: string; fullPath: string }> = [];
    for (const file of files) {
      const id = conversationIdFromFilename(file);
      if (!id) continue;
      targets.push({ id, fullPath: join(conversationsDir, file) });
    }

    for (let i = 0; i < targets.length; i += STAT_CONCURRENCY) {
      const batch = targets.slice(i, i + STAT_CONCURRENCY);
      const settled = await Promise.all(
        batch.map(async ({ id, fullPath }) => {
          try {
            const s = await stat(fullPath);
            return { id, mtime: s.mtime.toISOString() };
          } catch {
            return { id, mtime: new Date().toISOString() };
          }
        }),
      );
      for (const item of settled) {
        const existing = results.get(item.id);
        if (!existing || existing.mtime < item.mtime) {
          results.set(item.id, item);
        }
      }
    }
  }

  return [...results.values()];
}

export interface DiskConversationAnnotations {
  title?: string;
  archived?: boolean;
  pinned?: boolean;
  hasLastUserViewTime?: boolean;
  archivedAtSeconds?: number;
}

function parseAnnotationPbtxt(content: string): DiskConversationAnnotations {
  const titleMatch = content.match(/title:\s*"([^"]+)"/);
  const archivedMatch = content.match(/archived:\s*(true|false)/);
  const pinnedMatch = content.match(/pinned:\s*(true|false)/);
  const tsMatch = content.match(
    /archival_status_timestamp:\s*\{\s*seconds:\s*(\d+)/,
  );
  return {
    title: titleMatch?.[1],
    archived: archivedMatch?.[1] === "true",
    pinned: pinnedMatch ? pinnedMatch[1] === "true" : undefined,
    hasLastUserViewTime: content.includes("last_user_view_time:"),
    archivedAtSeconds: tsMatch ? Number(tsMatch[1]) : undefined,
  };
}

/**
 * Batch-load all existing *.pbtxt annotation files once per request via readdir,
 * avoiding hundreds of redundant ENOENT readFile calls across unannotated conversations.
 */
export async function loadDiskAnnotationsMap(
  appDataDirs: readonly string[] = KNOWN_APP_DATA_DIRS,
): Promise<Map<string, DiskConversationAnnotations>> {
  const map = new Map<string, DiskConversationAnnotations>();
  const geminiBase = resolveGeminiBaseDir();
  const READ_CONCURRENCY = 24;

  for (const appDataDir of appDataDirs) {
    const annDir = join(geminiBase, appDataDir, "annotations");
    let files: string[];
    try {
      files = await readdir(annDir);
    } catch {
      continue;
    }

    const pbtxtFiles = files.filter((f) => f.endsWith(".pbtxt"));
    for (let i = 0; i < pbtxtFiles.length; i += READ_CONCURRENCY) {
      const batch = pbtxtFiles.slice(i, i + READ_CONCURRENCY);
      const entries = await Promise.all(
        batch.map(async (file) => {
          const id = file.slice(0, -".pbtxt".length);
          if (map.has(id)) return null;
          try {
            const content = await readFile(join(annDir, file), "utf-8");
            return { id, parsed: parseAnnotationPbtxt(content) };
          } catch {
            return null;
          }
        }),
      );
      for (const entry of entries) {
        if (entry && !map.has(entry.id)) {
          map.set(entry.id, entry.parsed);
        }
      }
    }
  }

  return map;
}

export async function getConversationTitleFromDisk(
  id: string,
  appDataDirs: readonly string[] = KNOWN_APP_DATA_DIRS,
): Promise<string | undefined> {
  const meta = await getConversationAnnotationsFromDisk(id, appDataDirs);
  return meta?.title;
}

export async function getConversationAnnotationsFromDisk(
  id: string,
  appDataDirs: readonly string[] = KNOWN_APP_DATA_DIRS,
): Promise<DiskConversationAnnotations | undefined> {
  const geminiBase = resolveGeminiBaseDir();
  for (const appDataDir of appDataDirs) {
    const pbtxtPath = join(
      geminiBase,
      appDataDir,
      "annotations",
      `${id}.pbtxt`,
    );
    try {
      const content = await readFile(pbtxtPath, "utf-8");
      return parseAnnotationPbtxt(content);
    } catch {
      // not found in this appDataDir
    }
  }
  return undefined;
}

export async function isSubagentDiskConversation(
  id: string,
  appDataDirs: readonly string[] = KNOWN_APP_DATA_DIRS,
): Promise<boolean> {
  const geminiBase = resolveGeminiBaseDir();
  for (const appDataDir of appDataDirs) {
    const transcriptPath = join(
      geminiBase,
      appDataDir,
      "brain",
      id,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    let fh;
    try {
      fh = await open(transcriptPath, "r");
      const buf = Buffer.alloc(2048);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead <= 0) continue;
      const head = buf.subarray(0, bytesRead).toString("utf-8");
      const nl = head.indexOf("\n");
      const firstLine = (nl >= 0 ? head.slice(0, nl) : head).trim();
      if (!firstLine) continue;
      // Fast header check handles long first lines (>2KB SYSTEM_MESSAGE content) without JSON truncation errors.
      if (
        /"type"\s*:\s*"SYSTEM_MESSAGE"/.test(firstLine) &&
        /"source"\s*:\s*"SYSTEM"/.test(firstLine)
      ) {
        return true;
      }
      if (/"type"\s*:\s*"USER_INPUT"/.test(firstLine)) {
        return false;
      }
      try {
        const parsed = JSON.parse(firstLine) as {
          type?: string;
          source?: string;
        };
        return parsed.type === "SYSTEM_MESSAGE" && parsed.source === "SYSTEM";
      } catch {
        return false;
      }
    } catch {
      // No transcript in this appDataDir or first line exceeded 2KB
    } finally {
      await fh?.close();
    }
  }
  return false;
}

export interface ArchivedDiskConversationInfo {
  id: string;
  title?: string;
  lastModifiedTime: string;
}

export async function scanArchivedDiskConversations(
  appDataDirs: readonly string[] = KNOWN_APP_DATA_DIRS,
): Promise<ArchivedDiskConversationInfo[]> {
  const results = new Map<string, ArchivedDiskConversationInfo>();
  const geminiBase = resolveGeminiBaseDir();

  for (const appDataDir of appDataDirs) {
    const baseDir = join(geminiBase, appDataDir);
    const annotationsDir = join(baseDir, "annotations");
    const convDir = join(baseDir, "conversations");
    const brainDir = join(baseDir, "brain");

    let files: string[] = [];
    try {
      files = await readdir(annotationsDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".pbtxt")) continue;
      const id = file.slice(0, -".pbtxt".length);
      if (isSyntheticConversationId(id)) continue;

      const pbtxtPath = join(annotationsDir, file);
      try {
        const content = await readFile(pbtxtPath, "utf-8");
        const archivedMatch = content.match(/archived:\s*(true|false)/);
        if (archivedMatch?.[1] !== "true") continue;

        // Ensure a real conversation artifact exists on disk (avoid orphan test fixtures)
        let artifactMtime: Date | null = null;
        for (const candidate of [
          join(convDir, `${id}.pb`),
          join(convDir, `${id}.db`),
          join(brainDir, id),
        ]) {
          try {
            const st = await stat(candidate);
            artifactMtime = st.mtime;
            break;
          } catch {
            // continue checking
          }
        }
        if (!artifactMtime) continue;

        const titleMatch = content.match(/title:\s*"([^"]+)"/);
        const tsMatch = content.match(
          /archival_status_timestamp:\s*\{\s*seconds:\s*(\d+)/,
        );
        const archivedIso = tsMatch
          ? new Date(Number(tsMatch[1]) * 1000).toISOString()
          : artifactMtime.toISOString();

        const existing = results.get(id);
        if (!existing || existing.lastModifiedTime < archivedIso) {
          results.set(id, {
            id,
            title: titleMatch?.[1],
            lastModifiedTime: archivedIso,
          });
        }
      } catch {
        // ignore unreadable pbtxt
      }
    }
  }

  return [...results.values()];
}

export async function syncIntentionalArchiveRegistry(
  id: string,
  archived: boolean,
  title?: string,
): Promise<void> {
  const customFile = process.env.GEAR_INTENTIONAL_ARCHIVES_FILE;
  if (process.env.VITEST && !customFile) {
    return;
  }
  const registryPath =
    customFile ||
    join(homedir(), ".gemini", "antigravity", "jp-archives.json");
  try {
    let parsed: Record<string, unknown> = {};
    try {
      const raw = await readFile(registryPath, "utf-8");
      const json = JSON.parse(raw);
      if (json && typeof json === "object" && !Array.isArray(json)) {
        parsed = json as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }

    const convs =
      parsed.conversations &&
      typeof parsed.conversations === "object" &&
      !Array.isArray(parsed.conversations)
        ? { ...(parsed.conversations as Record<string, unknown>) }
        : {};

    if (archived) {
      convs[id] = {
        archived_at: new Date().toISOString(),
        reason: "porta_manual_archive",
        ...(title ? { title } : {}),
      };
    } else {
      delete convs[id];
      delete parsed[id];
    }

    parsed.conversations = convs;
    await mkdir(join(registryPath, ".."), { recursive: true });
    await writeFile(registryPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
  } catch {
    // Non-fatal if state directory is absent
  }
}

export async function setConversationAnnotationsOnDisk(
  id: string,
  patch: { title?: string; archived?: boolean; pinned?: boolean },
  appDataDirs: readonly string[] = KNOWN_APP_DATA_DIRS,
): Promise<boolean> {
  const geminiBase = resolveGeminiBaseDir();
  for (const appDataDir of appDataDirs) {
    const dir = join(geminiBase, appDataDir, "annotations");
    const pbtxtPath = join(dir, `${id}.pbtxt`);
    try {
      await mkdir(dir, { recursive: true });
      let content = "";
      try {
        content = await readFile(pbtxtPath, "utf-8");
      } catch {
        content = "";
      }

      if (patch.title !== undefined) {
        const cleanTitle = patch.title.replace(/[\r\n\t"]/g, " ").trim();
        if (cleanTitle) {
          if (content.includes("title:")) {
            content = content.replace(/title:\s*"[^"]*"/, `title:"${cleanTitle}"`);
          } else {
            content = `title:"${cleanTitle}" ${content}`.trim();
          }
        }
      }

      if (patch.archived !== undefined) {
        const val = patch.archived ? "true" : "false";
        const nowSec = Math.floor(Date.now() / 1000);
        if (/archived:\s*(true|false)/.test(content)) {
          content = content.replace(/archived:\s*(true|false)/, `archived:${val}`);
        } else {
          content = `${content} archived:${val}`.trim();
        }
        if (/archival_status_timestamp:\s*\{[^}]*\}/.test(content)) {
          content = content.replace(
            /archival_status_timestamp:\s*\{[^}]*\}/,
            `archival_status_timestamp:{seconds:${nowSec} nanos:0}`,
          );
        } else {
          content = `${content} archival_status_timestamp:{seconds:${nowSec} nanos:0}`.trim();
        }
      }

      if (patch.pinned !== undefined) {
        const pinVal = patch.pinned ? "true" : "false";
        if (/pinned:\s*(true|false)/.test(content)) {
          content = content.replace(/pinned:\s*(true|false)/, `pinned:${pinVal}`);
        } else {
          content = `${content} pinned:${pinVal}`.trim();
        }
      }

      await writeFile(pbtxtPath, content, "utf-8");
      return true;
    } catch {
      // Try next directory
    }
  }
  return false;
}

export async function setConversationTitleOnDisk(
  id: string,
  newTitle: string,
  appDataDirs: readonly string[] = KNOWN_APP_DATA_DIRS,
): Promise<boolean> {
  const cleanTitle = newTitle.replace(/[\r\n\t]/g, " ").trim();
  if (!cleanTitle) return false;
  return setConversationAnnotationsOnDisk(id, { title: cleanTitle }, appDataDirs);
}

export function conversationDirsForAppDataDirs(
  appDataDirs: Iterable<string | undefined>,
): string[] {
  const known = new Set<string>(KNOWN_APP_DATA_DIRS);
  const dirs = new Set<string>();

  for (const appDataDir of appDataDirs) {
    if (appDataDir && known.has(appDataDir)) {
      dirs.add(conversationDirForAppDataDir(appDataDir));
    }
  }

  return [...dirs];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function workspaceArray(value: unknown): ConversationWorkspaceMetadata[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((workspace) => ({
    ...(typeof workspace.workspaceFolderAbsoluteUri === "string"
      ? { workspaceFolderAbsoluteUri: workspace.workspaceFolderAbsoluteUri }
      : {}),
    ...(typeof workspace.gitRootAbsoluteUri === "string"
      ? { gitRootAbsoluteUri: workspace.gitRootAbsoluteUri }
      : {}),
    ...(isRecord(workspace.repository)
      ? {
          repository: {
            ...(typeof workspace.repository.computedName === "string"
              ? { computedName: workspace.repository.computedName }
              : {}),
            ...(typeof workspace.repository.gitOriginUrl === "string"
              ? { gitOriginUrl: workspace.repository.gitOriginUrl }
              : {}),
          },
        }
      : {}),
    ...(typeof workspace.branchName === "string"
      ? { branchName: workspace.branchName }
      : {}),
  }));
}

/**
 * Extract workspace metadata from a conversation summary.
 *
 * Antigravity 1.x exposed this at `summary.workspaces`. Antigravity 2.x still
 * exposes that for loaded conversations, but also mirrors it under
 * `summary.trajectoryMetadata.workspaces` and may only expose URI strings in
 * `summary.trajectoryMetadata.workspaceUris`.
 */
export function extractConversationWorkspaces(
  summary: unknown,
): ConversationWorkspaceMetadata[] {
  if (!isRecord(summary)) return [];

  const topLevel = workspaceArray(summary.workspaces);
  if (topLevel.length > 0) return topLevel;

  const trajectoryMetadata = summary.trajectoryMetadata;
  if (!isRecord(trajectoryMetadata)) return [];

  const metadataWorkspaces = workspaceArray(trajectoryMetadata.workspaces);
  if (metadataWorkspaces.length > 0) return metadataWorkspaces;

  if (!Array.isArray(trajectoryMetadata.workspaceUris)) return [];
  return trajectoryMetadata.workspaceUris
    .filter((uri): uri is string => typeof uri === "string")
    .map((uri) => ({ workspaceFolderAbsoluteUri: uri }));
}

export function getPrimaryWorkspaceUri(summary: unknown): string | undefined {
  return extractConversationWorkspaces(summary)[0]?.workspaceFolderAbsoluteUri;
}

export function withNormalizedConversationWorkspaces<T extends Record<string, unknown>>(
  summary: T,
): T {
  if (Array.isArray(summary.workspaces) && summary.workspaces.length > 0) {
    return summary;
  }

  const workspaces = extractConversationWorkspaces(summary);
  if (workspaces.length === 0) return summary;
  return { ...summary, workspaces };
}

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const PROJECT_MAPS_TTL_MS = 15_000;
let cachedProjectMaps: {
  loadedAt: number;
  projectNameMap: Map<string, string>;
  wsToProjectMap: Map<string, string>;
} | null = null;

export function invalidateProjectMapsCache(): void {
  cachedProjectMaps = null;
}

async function loadProjectMaps(): Promise<{
  projectNameMap: Map<string, string>;
  wsToProjectMap: Map<string, string>;
}> {
  const now = Date.now();
  if (
    !process.env.VITEST &&
    cachedProjectMaps &&
    now - cachedProjectMaps.loadedAt < PROJECT_MAPS_TTL_MS
  ) {
    return {
      projectNameMap: new Map(cachedProjectMaps.projectNameMap),
      wsToProjectMap: new Map(cachedProjectMaps.wsToProjectMap),
    };
  }

  const projectNameMap = new Map<string, string>();
  const wsToProjectMap = new Map<string, string>();
  const projectsDir = join(homedir(), ".gemini", "config", "projects");
  try {
    const files = (await readdir(projectsDir)).filter((f) => f.endsWith(".json"));
    const contents = await Promise.all(
      files.map(async (file) => {
        try {
          return await readFile(join(projectsDir, file), "utf8");
        } catch {
          return null;
        }
      }),
    );
    for (const content of contents) {
      if (!content) continue;
      try {
        const data = JSON.parse(content);
        if (data.id && data.name) {
          projectNameMap.set(data.id, safeDecodeUriComponent(data.name));
        }
        const resources = data?.projectResources?.resources;
        if (data.id && Array.isArray(resources)) {
          for (const res of resources) {
            if (typeof res?.folderUri === "string") {
              wsToProjectMap.set(res.folderUri.replace(/\/+$/, ""), data.id);
            }
          }
        }
      } catch {
        // ignore invalid json
      }
    }
  } catch {
    // projects dir missing or unreadable
  }

  if (!process.env.VITEST) {
    cachedProjectMaps = {
      loadedAt: now,
      projectNameMap: new Map(projectNameMap),
      wsToProjectMap: new Map(wsToProjectMap),
    };
  }

  return { projectNameMap, wsToProjectMap };
}

export async function getProjectNameMap(): Promise<Map<string, string>> {
  return (await loadProjectMaps()).projectNameMap;
}

export interface ChildSubagentDiskInfo {
  id: string;
  role: string;
  typeName: string;
  status: string;
  lastModifiedTime: string;
  stepCount?: number;
}

export interface BackgroundTaskLogInfo {
  id: string;
  fileName: string;
  sizeBytes: number;
  updatedAt: string;
  isActive: boolean;
  tailPreview: string;
}

export interface ActiveBackgroundTaskSummary {
  id: string;
  sizeBytes: number;
  updatedAt: string;
  isActive: boolean;
}

export interface ConversationTaskSummary {
  activeTasks: ActiveBackgroundTaskSummary[];
  taskCount: number;
}

export interface ConversationSubagentDiskRecord {
  id: string;
  role: string;
  typeName: string;
  state: string;
  spawnStepIndex?: number;
  lastModifiedTime: string;
}

async function readFileTailUtf8(
  filePath: string,
  fileSize: number,
  maxBytes = 2048,
): Promise<string> {
  if (fileSize <= 0) return "";
  let fh;
  try {
    fh = await open(filePath, "r");
    const len = Math.min(fileSize, maxBytes);
    const offset = Math.max(0, fileSize - len);
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    let text = buf.subarray(0, bytesRead).toString("utf-8");
    if (offset > 0) {
      const firstNl = text.indexOf("\n");
      if (firstNl >= 0) text = text.slice(firstNl + 1);
    }
    return text.trim().slice(-650);
  } catch {
    return "";
  } finally {
    await fh?.close();
  }
}

export async function getConversationBackgroundTasksFromDisk(
  conversationId: string,
  appDataDirs: readonly string[] = KNOWN_APP_DATA_DIRS,
  limit = 25,
): Promise<BackgroundTaskLogInfo[]> {
  if (!conversationId || isSyntheticConversationId(conversationId)) return [];
  const baseDir = resolveGeminiBaseDir();
  const seen = new Map<string, BackgroundTaskLogInfo>();
  const now = Date.now();

  for (const appDataDir of appDataDirs) {
    const tasksDir = join(
      baseDir,
      appDataDir,
      "brain",
      conversationId,
      ".system_generated",
      "tasks",
    );
    let files: string[];
    try {
      files = (await readdir(tasksDir)).filter((f) => f.endsWith(".log"));
    } catch {
      continue;
    }

    const withStats: Array<{ file: string; fullPath: string; mtimeMs: number; size: number }> = [];
    for (const file of files) {
      const fullPath = join(tasksDir, file);
      try {
        const st = await stat(fullPath);
        withStats.push({ file, fullPath, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // skip
      }
    }
    withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const item of withStats.slice(0, limit)) {
      const id = item.file.replace(/\.log$/, "");
      if (seen.has(id)) continue;
      const tailPreview = await readFileTailUtf8(item.fullPath, item.size, 2048);
      seen.set(id, {
        id,
        fileName: item.file,
        sizeBytes: item.size,
        updatedAt: new Date(item.mtimeMs).toISOString(),
        isActive: now - item.mtimeMs < 25_000,
        tailPreview,
      });
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/**
 * Fast directory-level summary of background tasks for sidebar rendering
 * (stat-only, never reads log bodies).
 */
export async function getConversationTaskSummaryFromDisk(
  conversationId: string,
  appDataDirs: readonly string[] = KNOWN_APP_DATA_DIRS,
  activeLimit = 5,
): Promise<ConversationTaskSummary> {
  if (!conversationId || isSyntheticConversationId(conversationId)) {
    return { activeTasks: [], taskCount: 0 };
  }
  const baseDir = resolveGeminiBaseDir();
  const seenIds = new Set<string>();
  const activeMap = new Map<string, ActiveBackgroundTaskSummary>();
  const now = Date.now();

  for (const appDataDir of appDataDirs) {
    const tasksDir = join(
      baseDir,
      appDataDir,
      "brain",
      conversationId,
      ".system_generated",
      "tasks",
    );
    let files: string[];
    try {
      files = (await readdir(tasksDir)).filter((f) => f.endsWith(".log"));
    } catch {
      continue;
    }

    for (const file of files) {
      const id = file.replace(/\.log$/, "");
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      try {
        const st = await stat(join(tasksDir, file));
        if (now - st.mtimeMs < 25_000) {
          activeMap.set(id, {
            id,
            sizeBytes: st.size,
            updatedAt: new Date(st.mtimeMs).toISOString(),
            isActive: true,
          });
        }
      } catch {
        // skip
      }
    }
  }

  const activeTasks = [...activeMap.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, activeLimit);

  return {
    activeTasks,
    taskCount: seenIds.size,
  };
}

export async function getDetailedSubagentsFromDisk(
  parentId: string,
  appDataDirs: readonly string[] = KNOWN_APP_DATA_DIRS,
): Promise<ConversationSubagentDiskRecord[]> {
  if (!parentId || isSyntheticConversationId(parentId)) return [];
  const baseDir = resolveGeminiBaseDir();
  const map = new Map<string, ConversationSubagentDiskRecord>();

  for (const appDataDir of appDataDirs) {
    const subagentsDir = join(
      baseDir,
      appDataDir,
      "brain",
      parentId,
      ".system_generated",
      "subagents",
    );
    let files: string[];
    try {
      files = (await readdir(subagentsDir)).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }

    for (const file of files) {
      const fullPath = join(subagentsDir, file);
      try {
        const raw = await readFile(fullPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          conversationId?: string;
          subagentDescriptor?: { typeName?: string; role?: string };
          state?: string;
          spawnStepIndex?: number;
        };
        const childId =
          typeof parsed.conversationId === "string" && parsed.conversationId
            ? parsed.conversationId
            : file.slice(0, -".json".length);
        if (!childId || isSyntheticConversationId(childId)) continue;
        const st = await stat(fullPath);
        map.set(childId, {
          id: childId,
          role:
            parsed.subagentDescriptor?.role?.trim() ||
            parsed.subagentDescriptor?.typeName?.trim() ||
            `エージェント ${childId.slice(0, 8)}`,
          typeName: parsed.subagentDescriptor?.typeName?.trim() || "subagent",
          state: parsed.state?.trim() || "SUBAGENT_STATE_UNKNOWN",
          ...(typeof parsed.spawnStepIndex === "number"
            ? { spawnStepIndex: parsed.spawnStepIndex }
            : {}),
          lastModifiedTime: st.mtime.toISOString(),
        });
      } catch {
        // skip
      }
    }
  }

  return [...map.values()].sort((a, b) =>
    b.lastModifiedTime.localeCompare(a.lastModifiedTime),
  );
}

export async function getChildSubagentsFromDisk(
  parentId: string,
  appDataDirs: readonly string[] = KNOWN_APP_DATA_DIRS,
): Promise<ChildSubagentDiskInfo[]> {
  if (!parentId || isSyntheticConversationId(parentId)) return [];
  const results = new Map<string, ChildSubagentDiskInfo>();

  for (const appDataDir of appDataDirs) {
    const subagentsDir = join(
      homedir(),
      ".gemini",
      appDataDir,
      "brain",
      parentId,
      ".system_generated",
      "subagents",
    );
    let files: string[] = [];
    try {
      files = await readdir(subagentsDir);
    } catch {
      continue;
    }

    const convDir = join(homedir(), ".gemini", appDataDir, "conversations");

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const fullPath = join(subagentsDir, file);
      try {
        const raw = await readFile(fullPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          conversationId?: string;
          subagentDescriptor?: { typeName?: string; role?: string };
          state?: string;
        };
        const childId =
          typeof parsed.conversationId === "string" && parsed.conversationId
            ? parsed.conversationId
            : file.slice(0, -".json".length);
        if (!childId || isSyntheticConversationId(childId)) continue;

        let mtimeIso: string | undefined;
        for (const candidate of [
          join(convDir, `${childId}.db`),
          join(convDir, `${childId}.pb`),
          fullPath,
        ]) {
          try {
            const st = await stat(candidate);
            mtimeIso = st.mtime.toISOString();
            break;
          } catch {
            // try next
          }
        }
        const lastModifiedTime = mtimeIso ?? new Date(0).toISOString();
        const role =
          parsed.subagentDescriptor?.role?.trim() ||
          parsed.subagentDescriptor?.typeName?.trim() ||
          `子チャット ${childId.slice(0, 8)}`;
        const typeName =
          parsed.subagentDescriptor?.typeName?.trim() || "subagent";

        const existing = results.get(childId);
        if (!existing || existing.lastModifiedTime < lastModifiedTime) {
          results.set(childId, {
            id: childId,
            role,
            typeName,
            status: "CASCADE_RUN_STATUS_IDLE",
            lastModifiedTime,
          });
        }
      } catch {
        // ignore unreadable or invalid subagent json
      }
    }
  }

  return [...results.values()];
}

export async function getWorkspaceToProjectIdMap(): Promise<Map<string, string>> {
  return (await loadProjectMaps()).wsToProjectMap;
}

export type ModelProviderId = "google" | "anthropic" | "openai" | "ollama";

export function inferModelProvider(labelOrId: string): ModelProviderId {
  const s = labelOrId.trim();
  if (/claude|anthropic|opus|sonnet|haiku/i.test(s)) return "anthropic";
  if (/\bgpt\b|gpt-|openai|codex|\bo[134](?:-|\b)/i.test(s)) return "openai";
  if (/qwen|ollama|llama|deepseek|mistral|gemma|phi|local-llm/i.test(s)) {
    return "ollama";
  }
  return "google";
}

const MAX_RECORDED_MODELS = 500;
const recordedConversationModels = new Map<
  string,
  { model: string; updatedAt: number }
>();

export function recordConversationModel(id: string, model: string): void {
  const trimmed = model.trim();
  if (!id || !trimmed) return;
  if (recordedConversationModels.has(id)) {
    recordedConversationModels.delete(id);
  }
  recordedConversationModels.set(id, {
    model: trimmed,
    updatedAt: Date.now(),
  });
  if (recordedConversationModels.size > MAX_RECORDED_MODELS) {
    const oldestKey = recordedConversationModels.keys().next().value;
    if (oldestKey !== undefined) {
      recordedConversationModels.delete(oldestKey);
    }
  }
}

export function getRecordedConversationModel(
  id: string,
): { model: string; updatedAt: number } | null {
  return recordedConversationModels.get(id) ?? null;
}

export function clearRecordedConversationModels(): void {
  recordedConversationModels.clear();
}

const MODEL_SELECTION_CHANGE_RE =
  /<USER_SETTINGS_CHANGE>\s*The user changed setting `Model Selection` from .+? to ([^\n]+?)\.(?:\s|$)/;

const TRANSCRIPT_MODEL_FULL_READ_LIMIT = 512 * 1024;
const TRANSCRIPT_MODEL_HEAD_BYTES = 64 * 1024;
const TRANSCRIPT_MODEL_TAIL_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_MODEL_CACHE = 500;

const transcriptModelCache = new Map<
  string,
  { mtimeMs: number; size: number; modelLabel: string | null }
>();
const transcriptModelInflight = new Map<string, Promise<string | null>>();

async function readTranscriptModelSample(
  transcriptPath: string,
  fileSize: number,
): Promise<string> {
  if (fileSize <= TRANSCRIPT_MODEL_FULL_READ_LIMIT) {
    return readFile(transcriptPath, "utf-8");
  }
  let fh;
  try {
    fh = await open(transcriptPath, "r");
    const headLen = Math.min(TRANSCRIPT_MODEL_HEAD_BYTES, fileSize);
    const tailLen = Math.min(
      TRANSCRIPT_MODEL_TAIL_BYTES,
      Math.max(0, fileSize - headLen),
    );
    const headBuf = Buffer.allocUnsafe(headLen);
    const { bytesRead: headRead } = await fh.read(headBuf, 0, headLen, 0);
    let headText = headBuf.subarray(0, headRead).toString("utf-8");
    const lastHeadNl = headText.lastIndexOf("\n");
    if (lastHeadNl >= 0) {
      headText = headText.slice(0, lastHeadNl);
    }

    if (tailLen <= 0) return headText;

    const tailBuf = Buffer.allocUnsafe(tailLen);
    const tailOffset = Math.max(headLen, fileSize - tailLen);
    const { bytesRead: tailRead } = await fh.read(tailBuf, 0, tailLen, tailOffset);
    let tailText = tailBuf.subarray(0, tailRead).toString("utf-8");
    const firstTailNl = tailText.indexOf("\n");
    if (firstTailNl >= 0) {
      tailText = tailText.slice(firstTailNl + 1);
    }
    return `${headText}\n${tailText}`;
  } finally {
    await fh?.close();
  }
}

function setTranscriptModelCache(
  path: string,
  entry: { mtimeMs: number; size: number; modelLabel: string | null },
): void {
  if (transcriptModelCache.has(path)) {
    transcriptModelCache.delete(path);
  }
  transcriptModelCache.set(path, entry);
  if (transcriptModelCache.size > MAX_TRANSCRIPT_MODEL_CACHE) {
    const oldest = transcriptModelCache.keys().next().value;
    if (oldest !== undefined) {
      transcriptModelCache.delete(oldest);
    }
  }
}

/**
 * Extract the latest selected human-readable model label from a conversation's
 * transcript.jsonl (`<USER_SETTINGS_CHANGE>` entries in `USER_INPUT` steps).
 * Uses bounded head+tail sampling for large transcripts and caches by `(mtimeMs, size)`.
 */
export async function getConversationModelFromTranscript(
  conversationId: string,
  appDataDirs: readonly string[] = KNOWN_APP_DATA_DIRS,
): Promise<string | null> {
  if (!conversationId || isSyntheticConversationId(conversationId)) {
    return null;
  }

  const baseDir = resolveGeminiBaseDir();
  const candidates: Array<{ path: string; mtimeMs: number; size: number }> = [];

  for (const appDataDir of appDataDirs) {
    const transcriptPath = join(
      baseDir,
      appDataDir,
      "brain",
      conversationId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    try {
      const st = await stat(transcriptPath);
      if (st.isFile() && st.size > 0) {
        candidates.push({
          path: transcriptPath,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      }
    } catch {
      // File does not exist in this appDataDir
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const cand of candidates) {
    const cached = transcriptModelCache.get(cand.path);
    if (cached && cached.mtimeMs === cand.mtimeMs && cached.size === cand.size) {
      if (cached.modelLabel) return cached.modelLabel;
      continue;
    }

    const inflightKey = `${cand.path}:${cand.mtimeMs}:${cand.size}`;
    let pending = transcriptModelInflight.get(inflightKey);
    if (!pending) {
      pending = (async () => {
        let modelLabel: string | null = null;
        try {
          const raw = await readTranscriptModelSample(cand.path, cand.size);
          const lines = raw.split("\n");
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (
              !line ||
              !line.includes("USER_SETTINGS_CHANGE") ||
              !line.includes("Model Selection")
            ) {
              continue;
            }
            try {
              const parsed = JSON.parse(line) as {
                type?: string;
                content?: unknown;
              };
              if (
                parsed.type !== "USER_INPUT" ||
                typeof parsed.content !== "string"
              ) {
                continue;
              }
              const match = MODEL_SELECTION_CHANGE_RE.exec(parsed.content);
              const candidateLabel = match?.[1]?.trim();
              if (candidateLabel && candidateLabel.toLowerCase() !== "none") {
                modelLabel = candidateLabel;
                break;
              }
            } catch {
              // Ignore malformed JSONL line
            }
          }
        } catch {
          // Ignore unreadable transcript
        }

        setTranscriptModelCache(cand.path, {
          mtimeMs: cand.mtimeMs,
          size: cand.size,
          modelLabel,
        });
        return modelLabel;
      })().finally(() => {
        transcriptModelInflight.delete(inflightKey);
      });
      transcriptModelInflight.set(inflightKey, pending);
    }

    const modelLabel = await pending;
    if (modelLabel) return modelLabel;
  }

  return null;
}
