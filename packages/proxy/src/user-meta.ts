/**
 * Antigravity 日本語版 ローカル永続メタデータストア
 *
 * 保存先: ~/.config/antigravity-jp/conversation-meta.json
 * （テスト時は PORTA_USER_META_FILE または VITEST 用の一時パスを使用）
 *
 * 役割:
 * 1. pinnedOverrides: Language Server の proto3 mergeAnnotations 仕様により
 *    `pinned: false` が上書きされずピン留めが復活する不具合を防ぐための確定状態
 * 2. projectAssignments: 既存チャットを手動でプロジェクト配下へ移動した割り当て
 * 3. projectSettings: 新規プロジェクト作成時のデフォルトフォルダ設定（配布時は空欄）
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface ProjectUserSettings {
  defaultProjectFolder: string;
  createProjectSubfolder: boolean;
}

/** プロジェクトから明示的に外されたことを示すセンチネルID（自動マッチ復活を防止） */
export const UNASSIGNED_PROJECT_ID = "__unassigned__";

export interface UserMetaStore {
  version: 1;
  pinnedOverrides: Record<string, boolean>;
  projectAssignments: Record<string, string>;
  projectSettings: ProjectUserSettings;
}

const DEFAULT_PROJECT_SETTINGS: ProjectUserSettings = {
  defaultProjectFolder: "",
  createProjectSubfolder: false,
};

function createEmptyStore(): UserMetaStore {
  return {
    version: 1,
    pinnedOverrides: {},
    projectAssignments: {},
    projectSettings: { ...DEFAULT_PROJECT_SETTINGS },
  };
}

export function resolveUserMetaFilePath(): string {
  if (process.env.PORTA_USER_META_FILE) {
    return process.env.PORTA_USER_META_FILE;
  }
  if (process.env.VITEST) {
    return join(tmpdir(), `porta-vitest-user-meta-${process.pid}.json`);
  }
  return join(homedir(), ".config", "antigravity-jp", "conversation-meta.json");
}

let cachedPath: string | null = null;
let cachedStore: UserMetaStore | null = null;
let writeQueue: Promise<void> = Promise.resolve();

export function invalidateUserMetaCache(): void {
  cachedStore = null;
  cachedPath = null;
}

function normalizeStore(raw: unknown): UserMetaStore {
  const base = createEmptyStore();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const obj = raw as Record<string, unknown>;

  if (
    obj.pinnedOverrides &&
    typeof obj.pinnedOverrides === "object" &&
    !Array.isArray(obj.pinnedOverrides)
  ) {
    for (const [k, v] of Object.entries(
      obj.pinnedOverrides as Record<string, unknown>,
    )) {
      if (typeof k === "string" && k.trim() && typeof v === "boolean") {
        base.pinnedOverrides[k] = v;
      }
    }
  }

  if (
    obj.projectAssignments &&
    typeof obj.projectAssignments === "object" &&
    !Array.isArray(obj.projectAssignments)
  ) {
    for (const [k, v] of Object.entries(
      obj.projectAssignments as Record<string, unknown>,
    )) {
      if (typeof k === "string" && k.trim() && typeof v === "string" && v.trim()) {
        base.projectAssignments[k] = v.trim();
      }
    }
  }

  if (
    obj.projectSettings &&
    typeof obj.projectSettings === "object" &&
    !Array.isArray(obj.projectSettings)
  ) {
    const ps = obj.projectSettings as Record<string, unknown>;
    if (typeof ps.defaultProjectFolder === "string") {
      base.projectSettings.defaultProjectFolder = ps.defaultProjectFolder.trim();
    }
    if (typeof ps.createProjectSubfolder === "boolean") {
      base.projectSettings.createProjectSubfolder = ps.createProjectSubfolder;
    }
  }

  return base;
}

export async function getUserMeta(): Promise<UserMetaStore> {
  const targetPath = resolveUserMetaFilePath();
  if (cachedStore && cachedPath === targetPath) {
    return cachedStore;
  }
  try {
    const raw = await readFile(targetPath, "utf-8");
    const parsed = JSON.parse(raw);
    cachedStore = normalizeStore(parsed);
  } catch {
    cachedStore = createEmptyStore();
  }
  cachedPath = targetPath;
  return cachedStore;
}

async function persistStore(store: UserMetaStore): Promise<void> {
  const targetPath = resolveUserMetaFilePath();
  cachedStore = store;
  cachedPath = targetPath;
  const serialized = `${JSON.stringify(store, null, 2)}\n`;
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, serialized, "utf-8");
    });
  await writeQueue;
}

export async function setPinnedOverride(
  conversationId: string,
  pinned: boolean,
): Promise<void> {
  const store = await getUserMeta();
  store.pinnedOverrides[conversationId] = pinned;
  await persistStore(store);
}

export async function setProjectAssignment(
  conversationId: string,
  projectId: string | null,
): Promise<void> {
  const store = await getUserMeta();
  if (projectId && projectId.trim()) {
    store.projectAssignments[conversationId] = projectId.trim();
  } else {
    delete store.projectAssignments[conversationId];
  }
  await persistStore(store);
}

export async function assignConversationsToProject(
  conversationIds: string[],
  projectId: string,
): Promise<number> {
  const targetId = projectId.trim();
  if (!targetId || conversationIds.length === 0) return 0;
  const store = await getUserMeta();
  let updated = 0;
  for (const rawId of conversationIds) {
    const convId = typeof rawId === "string" ? rawId.trim() : "";
    if (!convId) continue;
    if (store.projectAssignments[convId] !== targetId) {
      store.projectAssignments[convId] = targetId;
      updated += 1;
    }
  }
  if (updated > 0) {
    await persistStore(store);
  }
  return updated;
}

export async function clearProjectAssignmentsForProject(
  projectId: string,
): Promise<number> {
  const store = await getUserMeta();
  let removed = 0;
  for (const [convId, assignedId] of Object.entries(store.projectAssignments)) {
    if (assignedId === projectId) {
      delete store.projectAssignments[convId];
      removed += 1;
    }
  }
  if (removed > 0) {
    await persistStore(store);
  }
  return removed;
}

export async function getProjectSettings(): Promise<ProjectUserSettings> {
  const store = await getUserMeta();
  return { ...store.projectSettings };
}

export async function updateProjectSettings(
  patch: Partial<ProjectUserSettings>,
): Promise<ProjectUserSettings> {
  const store = await getUserMeta();
  if (typeof patch.defaultProjectFolder === "string") {
    store.projectSettings.defaultProjectFolder = patch.defaultProjectFolder.trim();
  }
  if (typeof patch.createProjectSubfolder === "boolean") {
    store.projectSettings.createProjectSubfolder = patch.createProjectSubfolder;
  }
  await persistStore(store);
  return { ...store.projectSettings };
}
