/**
 * Antigravity 会話アノテーション（~/.gemini/<appDataDir>/annotations/<id>.pbtxt）の読み取りユーティリティ
 *
 * 本家 Antigravity が保存する .pbtxt から archived / pinned / title を安全に読み取る。
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ConversationAnnotation {
  archived?: boolean;
  pinned?: boolean;
  title?: string;
}

const DEFAULT_APP_DATA_DIRS = [
  "antigravity",
  "antigravity-ide",
  "antigravity-cli",
];

/**
 * protobuf text format の文字列リテラルをデコードする。
 * 8進数バイトエスケープ (\343\201\202) と通常のエスケープ (\", \\, \n, \t) と生 UTF-8 の両方に対応。
 */
export function decodePbtxtString(raw: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next >= "0" && next <= "7") {
        // 最大3桁の8進数エスケープ
        let oct = next;
        let consumed = 1;
        if (i + 2 < raw.length && raw[i + 2] >= "0" && raw[i + 2] <= "7") {
          oct += raw[i + 2];
          consumed = 2;
          if (i + 3 < raw.length && raw[i + 3] >= "0" && raw[i + 3] <= "7") {
            oct += raw[i + 3];
            consumed = 3;
          }
        }
        bytes.push(parseInt(oct, 8) & 0xff);
        i += consumed;
        continue;
      }
      const escMap: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        '"': '"',
        "'": "'",
        "\\": "\\",
      };
      if (escMap[next] !== undefined) {
        for (const b of Buffer.from(escMap[next], "utf-8")) bytes.push(b);
        i += 1;
        continue;
      }
    }
    for (const b of Buffer.from(ch, "utf-8")) bytes.push(b);
  }
  return Buffer.from(bytes).toString("utf-8");
}

/**
 * .pbtxt 本文から archived / pinned / title を抽出する。
 */
export function parseAnnotationPbtxt(content: string): ConversationAnnotation {
  const result: ConversationAnnotation = {};

  const archivedMatch = content.match(/(?:^|\s)archived\s*:\s*(true|false)\b/);
  if (archivedMatch) {
    result.archived = archivedMatch[1] === "true";
  }

  const pinnedMatch = content.match(/(?:^|\s)pinned\s*:\s*(true|false)\b/);
  if (pinnedMatch) {
    result.pinned = pinnedMatch[1] === "true";
  }

  const titleMatch = content.match(
    /(?:^|\s)title\s*:\s*"((?:[^"\\]|\\.)*)"/,
  );
  if (titleMatch) {
    const decoded = decodePbtxtString(titleMatch[1]).trim();
    if (decoded) {
      result.title = decoded;
    }
  }

  return result;
}

function getAnnotationsDirs(appDataDirs?: string[]): string[] {
  if (process.env.AG_JP_ANNOTATIONS_DIR) {
    return [process.env.AG_JP_ANNOTATIONS_DIR];
  }
  const unique = new Set<string>(
    appDataDirs && appDataDirs.length > 0 ? appDataDirs : DEFAULT_APP_DATA_DIRS,
  );
  return [...unique].map((dir) => join(homedir(), ".gemini", dir, "annotations"));
}

/**
 * In-memory cache of recently updated annotations so that GET /api/conversations
 * immediately reflects pin/rename/archive even before the LS flushes .pbtxt to disk.
 */
const recentAnnotations = new Map<string, ConversationAnnotation>();

export function rememberConversationAnnotation(
  cascadeId: string,
  patch: ConversationAnnotation,
): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(cascadeId)) return;
  const prev = recentAnnotations.get(cascadeId) ?? {};
  recentAnnotations.set(cascadeId, { ...prev, ...patch });
}

export function clearRecentAnnotationsForTest(): void {
  recentAnnotations.clear();
}

export async function readConversationAnnotation(
  cascadeId: string,
  appDataDirs?: string[],
): Promise<ConversationAnnotation | null> {
  // パストラバーサル防止（UUID/英数ハイフンのみ許可）
  if (!/^[a-zA-Z0-9_-]+$/.test(cascadeId)) return null;

  const recent = recentAnnotations.get(cascadeId);
  let fromDisk: ConversationAnnotation | null = null;

  const dirs = getAnnotationsDirs(appDataDirs);
  for (const dir of dirs) {
    const filePath = join(dir, `${cascadeId}.pbtxt`);
    if (!existsSync(filePath)) continue;
    try {
      const content = await readFile(filePath, "utf-8");
      const parsed = parseAnnotationPbtxt(content);
      if (
        parsed.archived !== undefined ||
        parsed.pinned !== undefined ||
        parsed.title !== undefined
      ) {
        fromDisk = parsed;
        break;
      }
    } catch {
      // 読み込み失敗は無視して次へ
    }
  }

  if (!fromDisk && !recent) return null;
  return { ...(fromDisk ?? {}), ...(recent ?? {}) };
}
