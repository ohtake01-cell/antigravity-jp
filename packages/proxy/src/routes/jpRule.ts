import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Hono } from "hono";

const JP_RULE_START = "<!-- antigravity-jp-rule:start -->";
const JP_RULE_END = "<!-- antigravity-jp-rule:end -->";

export const JP_RULE_BLOCK = `${JP_RULE_START}
# 日本語運用ルール（Antigravity 日本語版）
- ユーザーへの返答、進捗報告、質問、エラー解説はすべて自然な日本語で行うこと。
- 計画書、タスク一覧、レポート（Artifact を含む）も必ず日本語で作成すること。
- 英語のエラーや専門用語が出たときは、必要に応じて原文を添えつつ日本語でわかりやすく説明すること。
- コード内コメントやドキュメントも、特段の指定がない限り日本語で書くこと。
- ファイルを削除する・大きな変更を行う・方針が分かれるときは、勝手に進めず先に日本語で確認すること。
- できないことや制約があるときは、推測で補わず最初に正直に日本語で伝えること。
${JP_RULE_END}`;

function getGlobalRulePath(): string {
  return (
    process.env.AG_JP_GLOBAL_RULE_PATH || join(homedir(), ".gemini", "GEMINI.md")
  );
}

export function registerJpRuleRoutes(app: Hono): void {
  app.get("/api/jp-rule", async (c) => {
    const rulePath = getGlobalRulePath();
    if (!existsSync(rulePath)) {
      return c.json({
        installed: false,
        fileExists: false,
        path: rulePath,
      });
    }
    try {
      const content = await readFile(rulePath, "utf-8");
      const installed =
        content.includes(JP_RULE_START) ||
        content.includes("日本語運用ルール");
      return c.json({
        installed,
        fileExists: true,
        path: rulePath,
      });
    } catch (err) {
      return c.json(
        {
          installed: false,
          fileExists: true,
          path: rulePath,
          error: (err as Error).message,
        },
        500,
      );
    }
  });

  app.post("/api/jp-rule", async (c) => {
    const rulePath = getGlobalRulePath();
    try {
      await mkdir(dirname(rulePath), { recursive: true });
      let backupPath: string | null = null;
      let existing = "";

      if (existsSync(rulePath)) {
        existing = await readFile(rulePath, "utf-8");
        if (existing.includes(JP_RULE_START)) {
          return c.json({
            ok: true,
            alreadyInstalled: true,
            path: rulePath,
            backupPath: null,
          });
        }
        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .slice(0, 19);
        backupPath = `${rulePath}.bak-${stamp}`;
        await copyFile(rulePath, backupPath);
      }

      const nextContent = existing.trim()
        ? `${existing.trimEnd()}\n\n${JP_RULE_BLOCK}\n`
        : `${JP_RULE_BLOCK}\n`;
      await writeFile(rulePath, nextContent, "utf-8");

      return c.json({
        ok: true,
        alreadyInstalled: false,
        path: rulePath,
        backupPath,
      });
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: `日本語ルールの保存に失敗しました: ${(err as Error).message}`,
        },
        500,
      );
    }
  });
}
