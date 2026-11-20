/**
 * /api/workspaces route
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
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

function localPathToFileUri(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.startsWith("file://")) return trimmed.replace(/\/+$/, "");
  const abs = resolve(trimmed);
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

  app.get("/api/projects", async (c) => {
    try {
      const projects = await listRegisteredProjects();
      return c.json({ projects });
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
      const folderPath = typeof body.folderPath === "string" ? body.folderPath.trim() : "";
      const rawName = typeof body.name === "string" ? body.name.trim() : "";
      const name = rawName || (folderPath ? basename(folderPath.replace(/\/+$/, "")) : "");
      if (!name) {
        return c.json({ error: "プロジェクト名またはフォルダパスを入力してください" }, 400);
      }

      const id = randomUUID();
      const folderUri = folderPath ? localPathToFileUri(folderPath) : undefined;
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

  app.delete("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || id === "default-cli-project") {
      return c.json({ error: "このプロジェクトは削除できません" }, 400);
    }
    try {
      const targetPath = join(resolveGeminiBaseDir(), "config", "projects", `${id}.json`);
      await unlink(targetPath);
      invalidateProjectMapsCache();
      return c.json({ ok: true, id });
    } catch {
      return c.json({ error: "プロジェクトが見つかりません" }, 404);
    }
  });
}
