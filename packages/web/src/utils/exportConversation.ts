/**
 * 会話の Markdown エクスポートユーティリティ
 *
 * 現在開いている会話のステップを取得して、ユーザー発言・AI 回答を
 * 読みやすい Markdown に整形し、ダウンロードまたはクリップボードコピーする。
 */

import { api } from "../api/client";
import { stepsToMessages } from "../transforms/stepsToMessages";

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

export async function buildConversationMarkdown(
  cascadeId: string,
  title: string,
): Promise<string> {
  const res = await api.getSteps(cascadeId, 0, 2000);
  const messages = stepsToMessages(res.steps ?? [], res.offset ?? 0);
  return formatConversationAsMarkdown(title, messages);
}

export function downloadMarkdownFile(filenameBase: string, markdown: string): void {
  const safeName =
    filenameBase
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "_")
      .slice(0, 64) || "conversation";
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
