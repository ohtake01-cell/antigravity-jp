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
 *
 * 複数プロセス（Macアプリ / スマホ版 / Porta）から同じファイルを参照しても
 * 常に最新が反映されるよう、ファイルの mtimeMs + size でキャッシュ鮮度を検証し、
 * 書き込み時も最新ディスク内容を読み直してからアトミックに保存する。
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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

function cloneStore(store: UserMetaStore): UserMetaStore {
  return {
    version: 1,
    pinnedOverrides: { ...store.pinnedOverrides },
    projectAssignments: { ...store.projectAssignments },
    projectSettings: { ...store.projectSettings },
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
let cachedSig: string | null = null;
let cachedStore: UserMetaStore | null = null;
let writeQueue: Promise<void> = Promise.resolve();

export function invalidateUserMetaCache(): void {
  cachedStore = null;
  cachedPath = null;
  cachedSig = null;
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

async function readStoreFromDisk(targetPath: string): Promise<{
  store: UserMetaStore;
  sig: string | null;
}> {
  try {
    const st = await stat(targetPath);
    const sig = `${st.mtimeMs}:${st.size}`;
    if (cachedStore && cachedPath === targetPath && cachedSig === sig) {
      return { store: cloneStore(cachedStore), sig };
    }
    const raw = await readFile(targetPath, "utf-8");
    const parsed = normalizeStore(JSON.parse(raw));
    cachedStore = cloneStore(parsed);
    cachedPath = targetPath;
    cachedSig = sig;
    return { store: parsed, sig };
  } catch {
    const empty = createEmptyStore();
    cachedStore = cloneStore(empty);
    cachedPath = targetPath;
    cachedSig = null;
    return { store: empty, sig: null };
  }
}

export async function getUserMeta(): Promise<UserMetaStore> {
  const targetPath = resolveUserMetaFilePath();
  const { store } = await readStoreFromDisk(targetPath);
  return store;
}

async function mutateStore(
  mutator: (store: UserMetaStore) => boolean | void,
): Promise<UserMetaStore> {
  const targetPath = resolveUserMetaFilePath();
  let resultStore = createEmptyStore();
  const job = writeQueue
    .catch(() => {})
    .then(async () => {
      // 書き込み直前に必ず最新ディスクを読み直して他プロセスの変更を保持する
      const { store } = await readStoreFromDisk(targetPath);
      const shouldWrite = mutator(store);
      resultStore = cloneStore(store);
      if (shouldWrite === false) return;
      const serialized = `${JSON.stringify(store, null, 2)}\n`;
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, serialized, "utf-8");
      try {
        const st = await stat(targetPath);
        cachedSig = `${st.mtimeMs}:${st.size}`;
      } catch {
        cachedSig = null;
      }
      cachedPath = targetPath;
      cachedStore = cloneStore(store);
    });
  writeQueue = job;
  await job;
  return resultStore;
}

export async function setPinnedOverride(
  conversationId: string,
  pinned: boolean,
): Promise<void> {
  await mutateStore((store) => {
    store.pinnedOverrides[conversationId] = pinned;
  });
}

export async function setProjectAssignment(
  conversationId: string,
  projectId: string | null,
): Promise<void> {
  await mutateStore((store) => {
    if (projectId && projectId.trim()) {
      store.projectAssignments[conversationId] = projectId.trim();
    } else {
      delete store.projectAssignments[conversationId];
    }
  });
}

export async function assignConversationsToProject(
  conversationIds: string[],
  projectId: string,
): Promise<number> {
  const targetId = projectId.trim();
  if (!targetId || conversationIds.length === 0) return 0;
  let updated = 0;
  await mutateStore((store) => {
    for (const rawId of conversationIds) {
      const convId = typeof rawId === "string" ? rawId.trim() : "";
      if (!convId) continue;
      if (store.projectAssignments[convId] !== targetId) {
        store.projectAssignments[convId] = targetId;
        updated += 1;
      }
    }
    return updated > 0;
  });
  return updated;
}

export async function clearProjectAssignmentsForProject(
  projectId: string,
): Promise<number> {
  let removed = 0;
  await mutateStore((store) => {
    for (const [convId, assignedId] of Object.entries(store.projectAssignments)) {
      if (assignedId === projectId) {
        delete store.projectAssignments[convId];
        removed += 1;
      }
    }
    return removed > 0;
  });
  return removed;
}

export async function getProjectSettings(): Promise<ProjectUserSettings> {
  const store = await getUserMeta();
  return { ...store.projectSettings };
}

export async function updateProjectSettings(
  patch: Partial<ProjectUserSettings>,
): Promise<ProjectUserSettings> {
  const updated = await mutateStore((store) => {
    if (typeof patch.defaultProjectFolder === "string") {
      store.projectSettings.defaultProjectFolder = patch.defaultProjectFolder.trim();
    }
    if (typeof patch.createProjectSubfolder === "boolean") {
      store.projectSettings.createProjectSubfolder = patch.createProjectSubfolder;
    }
  });
  return { ...updated.projectSettings };
}
