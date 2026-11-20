/**
 * /api/workspaces route
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Hono } from "hono";
import { discovery, rpc, extractTargetAppDataDir } from "../routing.js";
import { handleRPCError } from "../errors.js";
import {
  extractConversationWorkspaces,
  getWorkspaceToProjectIdMap,
  invalidateProjectMapsCache,
  resolveGeminiBaseDir,
} from "../metadata.js";
import {
  assignConversationsToProject,
  clearProjectAssignmentsForProject,
  getProjectSettings,
  updateProjectSettings,
} from "../user-meta.js";

export interface RegisteredProject {
  id: string;
  name: string;
  folderUri?: string;
  folderPath?: string;
  isDefaultCli?: boolean;
}

function fileUriToLocalPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri.replace(/^file:\/\//, "");
  }
}

export function expandHomePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function sanitizeSubfolderName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "project";
}

function localPathToFileUri(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.startsWith("file://")) return trimmed.replace(/\/+$/, "");
  const abs = resolve(expandHomePath(trimmed));
  const encoded = abs
    .split("/")
    .map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg)))
    .join("/");
  return `file://${encoded}`;
}

async function listRegisteredProjects(): Promise<RegisteredProject[]> {
  const projectsDir = join(resolveGeminiBaseDir(), "config", "projects");
  let files: string[];
  try {
    files = (await readdir(projectsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const projects: RegisteredProject[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(join(projectsDir, file), "utf-8");
      const data = JSON.parse(raw) as {
        id?: string;
        name?: string;
        sidecar?: unknown;
        projectResources?: { resources?: Array<{ folderUri?: string }> };
      };
      // Skip internal sidecar entries (e.g., swarm/swarm_board), matching Antigravity sidebar
      if (!data.id || !data.name || data.sidecar) continue;
      const folderUri = data.projectResources?.resources?.find(
        (r) => typeof r?.folderUri === "string" && r.folderUri.length > 0,
      )?.folderUri;
      projects.push({
        id: data.id,
        name: data.name,
        ...(folderUri
          ? { folderUri, folderPath: fileUriToLocalPath(folderUri) }
          : {}),
        ...(data.id === "default-cli-project" ? { isDefaultCli: true } : {}),
      });
    } catch {
      // Skip unreadable/corrupt json
    }
  }

  projects.sort((a, b) => {
    if (a.isDefaultCli !== b.isDefaultCli) return a.isDefaultCli ? 1 : -1;
    return a.name.localeCompare(b.name, "ja");
  });
  return projects;
}

export function registerWorkspaceRoutes(app: Hono): void {
  app.get("/api/workspaces", async (c) => {
    try {
      const targetApp = extractTargetAppDataDir(c);
      const instances = await discovery.getInstances(false, targetApp);
      const workspaceMap = new Map<
        string,
        { workspaceUri: string; gitRootUri?: string }
      >();
      let homeDirPath = "";
      let homeDirUri = "";

      await Promise.allSettled(
        instances.map(async (inst) => {
          try {
            const data = (await rpc.call("GetWorkspaceInfos", {}, inst)) as {
              homeDirPath?: string;
              homeDirUri?: string;
              workspaceInfos?: { workspaceUri: string; gitRootUri?: string }[];
            };
            if (data.homeDirPath) homeDirPath = data.homeDirPath;
            if (data.homeDirUri) homeDirUri = data.homeDirUri;
            for (const info of data.workspaceInfos ?? []) {
              workspaceMap.set(info.workspaceUri, info);
            }
          } catch {
            // Skip unreachable instances
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
                const workspaceUri = workspace.workspaceFolderAbsoluteUri;
                if (!workspaceUri || workspaceMap.has(workspaceUri)) continue;
                workspaceMap.set(workspaceUri, {
                  workspaceUri,
                  ...(workspace.gitRootAbsoluteUri
                    ? { gitRootUri: workspace.gitRootAbsoluteUri }
                    : {}),
                });
              }
            }
          } catch {
            // Conversation summaries are a fallback for Antigravity 2.x hub LS.
          }
        }),
      );

      // Fallback for freshly booted headless agy --hub before any trajectories are warmed up:
      // surface configured project folder URIs from ~/.gemini/config/projects/*.json.
      if (workspaceMap.size === 0 && !process.env.VITEST) {
        const wsToProjectMap = await getWorkspaceToProjectIdMap();
        for (const folderUri of wsToProjectMap.keys()) {
          if (folderUri && !workspaceMap.has(folderUri)) {
            workspaceMap.set(folderUri, { workspaceUri: folderUri });
          }
        }
      }

      return c.json({
        homeDirPath,
        homeDirUri,
        workspaceInfos: Array.from(workspaceMap.values()),
      });
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  app.get("/api/projects/settings", async (c) => {
    try {
      const settings = await getProjectSettings();
      return c.json({ settings });
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  app.patch("/api/projects/settings", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        defaultProjectFolder?: string;
        createProjectSubfolder?: boolean;
      };
      const patch: {
        defaultProjectFolder?: string;
        createProjectSubfolder?: boolean;
      } = {};
      if (typeof body.defaultProjectFolder === "string") {
        patch.defaultProjectFolder = body.defaultProjectFolder.trim();
      }
      if (typeof body.createProjectSubfolder === "boolean") {
        patch.createProjectSubfolder = body.createProjectSubfolder;
      }
      const settings = await updateProjectSettings(patch);
      return c.json({ ok: true, settings });
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  app.get("/api/projects", async (c) => {
    try {
      const [projects, settings] = await Promise.all([
        listRegisteredProjects(),
        getProjectSettings(),
      ]);
      return c.json({ projects, settings });
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  app.post("/api/projects", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        name?: string;
        folderPath?: string;
      };
      const rawFolderPath =
        typeof body.folderPath === "string" ? body.folderPath.trim() : "";
      const rawName = typeof body.name === "string" ? body.name.trim() : "";
      const name =
        rawName ||
        (rawFolderPath ? basename(expandHomePath(rawFolderPath).replace(/\/+$/, "")) : "");
      if (!name) {
        return c.json({ error: "プロジェクト名またはフォルダパスを入力してください" }, 400);
      }

      let effectiveFolderPath = rawFolderPath;
      if (!effectiveFolderPath) {
        const settings = await getProjectSettings();
        if (settings.defaultProjectFolder) {
          const baseFolder = resolve(expandHomePath(settings.defaultProjectFolder));
          if (settings.createProjectSubfolder) {
            const subPath = join(baseFolder, sanitizeSubfolderName(name));
            await mkdir(subPath, { recursive: true });
            effectiveFolderPath = subPath;
          } else {
            effectiveFolderPath = baseFolder;
          }
        }
      }

      const id = randomUUID();
      const folderUri = effectiveFolderPath
        ? localPathToFileUri(effectiveFolderPath)
        : undefined;
      const projectsDir = join(resolveGeminiBaseDir(), "config", "projects");
      await mkdir(projectsDir, { recursive: true });
      const payload = {
        id,
        name,
        projectResources: folderUri
          ? { resources: [{ folderUri }] }
          : {},
        permissionGrants: { v2Migrated: true },
        settings: {},
        isWorkspaceOnly: false,
      };
      await writeFile(
        join(projectsDir, `${id}.json`),
        `${JSON.stringify(payload, null, 2)}\n`,
        "utf-8",
      );
      invalidateProjectMapsCache();

      const project: RegisteredProject = {
        id,
        name,
        ...(folderUri ? { folderUri, folderPath: fileUriToLocalPath(folderUri) } : {}),
      };
      return c.json({ project }, 201);
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  app.patch("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || id === "default-cli-project") {
      return c.json({ error: "このプロジェクトは編集できません" }, 400);
    }
    try {
      const targetPath = join(resolveGeminiBaseDir(), "config", "projects", `${id}.json`);
      let existing: Record<string, unknown>;
      try {
        existing = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>;
      } catch {
        return c.json({ error: "プロジェクトが見つかりません" }, 404);
      }

      const body = (await c.req.json().catch(() => ({}))) as {
        name?: string;
        folderPath?: string;
        clearFolder?: boolean;
        createFolderIfMissing?: boolean;
        preserveConversationIds?: string[];
      };

      const nextName =
        typeof body.name === "string"
          ? body.name.trim()
          : typeof existing.name === "string"
            ? existing.name.trim()
            : "";
      if (!nextName) {
        return c.json({ error: "プロジェクト名を入力してください" }, 400);
      }

      const existingResources = (
        existing.projectResources as
          | { resources?: Array<{ folderUri?: string }> }
          | undefined
      )?.resources;
      const oldFolderUri = existingResources?.find(
        (r) => typeof r?.folderUri === "string" && r.folderUri.length > 0,
      )?.folderUri;

      let nextFolderUri: string | undefined;
      if (body.clearFolder === true) {
        nextFolderUri = undefined;
      } else if (typeof body.folderPath === "string") {
        let trimmedPath = body.folderPath.trim();
        // パス空欄で保存した場合（明示的な解除でない場合）はデフォルトフォルダを自動適用
        if (!trimmedPath) {
          const settings = await getProjectSettings();
          if (settings.defaultProjectFolder) {
            const baseFolder = resolve(expandHomePath(settings.defaultProjectFolder));
            if (settings.createProjectSubfolder) {
              const subPath = join(baseFolder, sanitizeSubfolderName(nextName));
              await mkdir(subPath, { recursive: true });
              trimmedPath = subPath;
            } else {
              trimmedPath = baseFolder;
            }
          }
        }
        if (trimmedPath) {
          const absPath = resolve(expandHomePath(trimmedPath));
          if (body.createFolderIfMissing === true) {
            await mkdir(absPath, { recursive: true });
          } else {
            try {
              const st = await stat(absPath);
              if (!st.isDirectory()) {
                return c.json(
                  { error: "指定されたパスはフォルダではなくファイルです" },
                  400,
                );
              }
            } catch {
              return c.json(
                {
                  error:
                    "指定されたフォルダが見つかりません。「フォルダが無い場合は自動作成する」にチェックを入れるか、実在するパスを指定してください",
                },
                400,
              );
            }
          }
          nextFolderUri = localPathToFileUri(absPath);
        } else {
          nextFolderUri = undefined;
        }
      } else {
        nextFolderUri = oldFolderUri;
      }

      const updatedPayload = {
        ...existing,
        id,
        name: nextName,
        projectResources: nextFolderUri
          ? { resources: [{ folderUri: nextFolderUri }] }
          : {},
      };
      await writeFile(
        targetPath,
        `${JSON.stringify(updatedPayload, null, 2)}\n`,
        "utf-8",
      );
      invalidateProjectMapsCache();

      // パス変更時に元々このプロジェクトに表示されていたチャットが外へ飛び散らないようID固定する
      const folderChanged =
        (oldFolderUri?.replace(/\/+$/, "") ?? "") !==
        (nextFolderUri?.replace(/\/+$/, "") ?? "");
      if (
        folderChanged &&
        Array.isArray(body.preserveConversationIds) &&
        body.preserveConversationIds.length > 0
      ) {
        await assignConversationsToProject(body.preserveConversationIds, id);
      }

      const project: RegisteredProject = {
        id,
        name: nextName,
        ...(nextFolderUri
          ? { folderUri: nextFolderUri, folderPath: fileUriToLocalPath(nextFolderUri) }
          : {}),
      };
      return c.json({ ok: true, project });
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  app.delete("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || id === "default-cli-project") {
      return c.json({ error: "このプロジェクトは削除できません" }, 400);
    }
    try {
      const targetPath = join(resolveGeminiBaseDir(), "config", "projects", `${id}.json`);
      await unlink(targetPath);
      invalidateProjectMapsCache();
      await clearProjectAssignmentsForProject(id);
      return c.json({ ok: true, id });
    } catch {
      return c.json({ error: "プロジェクトが見つかりません" }, 404);
    }
  });
}
