/**
 * 会話の Markdown エクスポート & クリップボードユーティリティ
 *
 * - ページネーションで全ステップ（最大 5000 ステップ）を取得して Markdown 整形
 * - macOS ネイティブアプリ（Antigravity 日本語版）では
 *   ネイティブ NSSavePanel / NSPasteboard ブリッジを自動利用し、
 *   通常ブラウザでは標準 Download / Clipboard API を使用する。
 */

import { api } from "../api/client";
import { stepsToMessages } from "../transforms/stepsToMessages";
import type { TrajectoryStep } from "../types";

interface WebkitBridgeHandlers {
  agJpNative?: { postMessage: (msg: Record<string, unknown>) => void };
  portaCopy?: { postMessage: (text: string) => void };
}

function getWebkitHandlers(): WebkitBridgeHandlers | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    webkit?: { messageHandlers?: WebkitBridgeHandlers };
  };
  return w.webkit?.messageHandlers;
}

export function formatConversationAsMarkdown(
  title: string,
  messages: ReturnType<typeof stepsToMessages>,
): string {
  const safeTitle = title.trim() || "会話ログ";
  const exportedAt = new Date().toLocaleString("ja-JP");
  const lines: string[] = [
    `# ${safeTitle}`,
    "",
    `> エクスポート日時: ${exportedAt}`,
    "",
    "---",
    "",
  ];

  for (const msg of messages) {
    if (msg.role === "user" && msg.content.trim()) {
      lines.push("## ユーザー", "", msg.content.trim(), "", "---", "");
    } else if (msg.role === "assistant" && msg.content.trim()) {
      lines.push("## AI", "", msg.content.trim(), "", "---", "");
    }
  }

  return lines.join("\n").trim() + "\n";
}

const PAGE_LIMIT = 500;
const MAX_EXPORT_STEPS = 5000;

export async function buildConversationMarkdown(
  cascadeId: string,
  title: string,
): Promise<string> {
  const allSteps: TrajectoryStep[] = [];
  let offset = 0;

  while (offset < MAX_EXPORT_STEPS) {
    const res = await api.getSteps(cascadeId, offset, PAGE_LIMIT);
    const batch = res.steps ?? [];
    if (batch.length === 0) break;
    allSteps.push(...batch);
    const total =
      typeof res.stepCount === "number" ? res.stepCount : allSteps.length;
    offset += batch.length;
    if (offset >= total || batch.length < PAGE_LIMIT) break;
  }

  const messages = stepsToMessages(allSteps, 0);
  return formatConversationAsMarkdown(title, messages);
}

/**
 * クリップボードへ確実にコピーする（Mac ネイティブアプリ / Safari / Chrome 全対応）
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  const handlers = getWebkitHandlers();
  if (handlers?.agJpNative) {
    handlers.agJpNative.postMessage({ type: "copy", text });
    return;
  }
  if (handlers?.portaCopy) {
    handlers.portaCopy.postMessage(text);
    return;
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // WKWebView や非同期ジェスチャー失効時は textarea フォールバックへ
    }
  }

  if (typeof document !== "undefined") {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) return;
  }

  throw new Error("クリップボードへのコピーに失敗しました");
}

/**
 * Markdown ファイルを保存する（Mac アプリでは NSSavePanel、ブラウザでは標準ダウンロード）
 */
export function downloadMarkdownFile(filenameBase: string, markdown: string): void {
  const safeName =
    filenameBase
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "_")
      .slice(0, 64) || "conversation";
  const filename = `${safeName}.md`;

  const handlers = getWebkitHandlers();
  if (handlers?.agJpNative) {
    handlers.agJpNative.postMessage({
      type: "save-file",
      filename,
      content: markdown,
    });
    return;
  }

  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
