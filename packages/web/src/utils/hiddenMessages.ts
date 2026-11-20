/**
 * クライアントローカル保存による「コメント単体非表示」ユーティリティ
 *
 * Antigravity Language Server の仕様上、単一コメントのピンポイント物理削除 RPC は
 * 存在しない（巻き戻し `RevertToCascadeStep` のみ）。そのため、単体コメントを
 * 画面から除去したい場合はローカルに非表示リストとして保存し、いつでも設定画面や
 * チャット上部の復元バーから元に戻せるようにする。
 */

const STORAGE_KEY = "antigravity-jp:hidden-messages";
const CHANGE_EVENT = "antigravity-jp:hidden-messages-changed";

export interface HiddenMessageRecord {
  cascadeId: string;
  stepIndex: number;
  role: "user" | "assistant" | "system";
  preview: string;
  hiddenAt: number;
}

type HiddenMap = Record<string, HiddenMessageRecord[]>;

function readMap(): HiddenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as HiddenMap;
  } catch {
    return {};
  }
}

function writeMap(map: HiddenMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    // localStorage 書き込み失敗時は無視
  }
}

export function getHiddenStepSet(cascadeId: string): Set<number> {
  const list = readMap()[cascadeId] ?? [];
  return new Set(list.map((item) => item.stepIndex));
}

export function getHiddenMessagesForConversation(
  cascadeId: string,
): HiddenMessageRecord[] {
  return readMap()[cascadeId] ?? [];
}

export function getAllHiddenMessages(): HiddenMessageRecord[] {
  const map = readMap();
  return Object.values(map)
    .flat()
    .sort((a, b) => b.hiddenAt - a.hiddenAt);
}

export function hideMessageLocally(
  cascadeId: string,
  stepIndex: number,
  role: "user" | "assistant" | "system",
  content: string,
): void {
  const map = readMap();
  const list = map[cascadeId] ?? [];
  if (list.some((item) => item.stepIndex === stepIndex)) return;
  const cleaned = content.replace(/\s+/g, " ").trim();
  const preview =
    cleaned.length > 80 ? `${cleaned.slice(0, 77)}…` : cleaned || "(内容なし)";
  map[cascadeId] = [
    ...list,
    {
      cascadeId,
      stepIndex,
      role,
      preview,
      hiddenAt: Date.now(),
    },
  ];
  writeMap(map);
}

export function unhideMessageLocally(
  cascadeId: string,
  stepIndex: number,
): void {
  const map = readMap();
  const list = map[cascadeId];
  if (!list) return;
  const next = list.filter((item) => item.stepIndex !== stepIndex);
  if (next.length === 0) {
    delete map[cascadeId];
  } else {
    map[cascadeId] = next;
  }
  writeMap(map);
}

export function unhideAllForConversation(cascadeId: string): void {
  const map = readMap();
  if (!map[cascadeId]) return;
  delete map[cascadeId];
  writeMap(map);
}

export function clearAllHiddenMessages(): void {
  writeMap({});
}

export function subscribeHiddenMessages(listener: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
