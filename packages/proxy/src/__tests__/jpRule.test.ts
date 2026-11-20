import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JP_RULE_BLOCK, registerJpRuleRoutes } from "../routes/jpRule.js";

function createApp() {
  const app = new Hono();
  registerJpRuleRoutes(app);
  return app;
}

describe("registerJpRuleRoutes", () => {
  let tempDir: string;
  let rulePath: string;
  const originalEnvPath = process.env.AG_JP_GLOBAL_RULE_PATH;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ag-jp-rule-test-"));
    rulePath = join(tempDir, ".gemini", "GEMINI.md");
    process.env.AG_JP_GLOBAL_RULE_PATH = rulePath;
  });

  afterEach(async () => {
    if (originalEnvPath === undefined) {
      delete process.env.AG_JP_GLOBAL_RULE_PATH;
    } else {
      process.env.AG_JP_GLOBAL_RULE_PATH = originalEnvPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("GET /api/jp-rule", () => {
    it("reports fileExists: false and installed: false when rule file does not exist", async () => {
      const app = createApp();
      const res = await app.request("/api/jp-rule");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({
        installed: false,
        fileExists: false,
        path: rulePath,
      });
    });

    it("reports fileExists: true and installed: false when file exists without Japanese rule", async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dirname(rulePath), { recursive: true });
      await writeFile(rulePath, "# Existing Rules\n- Be concise.\n", "utf-8");

      const app = createApp();
      const res = await app.request("/api/jp-rule");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({
        installed: false,
        fileExists: true,
        path: rulePath,
      });
    });

    it("reports installed: true when file contains the Japanese rule marker", async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dirname(rulePath), { recursive: true });
      await writeFile(rulePath, `${JP_RULE_BLOCK}\n`, "utf-8");

      const app = createApp();
      const res = await app.request("/api/jp-rule");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({
        installed: true,
        fileExists: true,
        path: rulePath,
      });
    });

    it("reports installed: true when file contains '日本語運用ルール' manually", async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dirname(rulePath), { recursive: true });
      await writeFile(rulePath, "# 日本語運用ルール\n- 日本語で答える\n", "utf-8");

      const app = createApp();
      const res = await app.request("/api/jp-rule");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({
        installed: true,
        fileExists: true,
        path: rulePath,
      });
    });
  });

  describe("POST /api/jp-rule", () => {
    it("creates a new rule file and parent directory without backup when file does not exist", async () => {
      const app = createApp();
      const postRes = await app.request("/api/jp-rule", { method: "POST" });
      const postBody = await postRes.json();

      expect(postRes.status).toBe(200);
      expect(postBody).toEqual({
        ok: true,
        alreadyInstalled: false,
        path: rulePath,
        backupPath: null,
      });

      expect(existsSync(rulePath)).toBe(true);
      const written = await readFile(rulePath, "utf-8");
      expect(written).toBe(`${JP_RULE_BLOCK}\n`);

      const entries = await readdir(dirname(rulePath));
      expect(entries).toEqual(["GEMINI.md"]);

      const getRes = await app.request("/api/jp-rule");
      const getBody = await getRes.json();
      expect(getBody).toEqual({
        installed: true,
        fileExists: true,
        path: rulePath,
      });
    });

    it("backs up existing file to .bak-* and appends the Japanese rule block", async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dirname(rulePath), { recursive: true });
      const originalContent = "# My Custom Rules\n- Always write tests.\n";
      await writeFile(rulePath, originalContent, "utf-8");

      const app = createApp();
      const res = await app.request("/api/jp-rule", { method: "POST" });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.alreadyInstalled).toBe(false);
      expect(body.path).toBe(rulePath);
      expect(typeof body.backupPath).toBe("string");
      expect(body.backupPath).toMatch(
        new RegExp(`^${rulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.bak-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}$`),
      );

      // Verify backup preserves original content verbatim
      expect(existsSync(body.backupPath)).toBe(true);
      const backupContent = await readFile(body.backupPath, "utf-8");
      expect(backupContent).toBe(originalContent);

      // Verify existing content is preserved and JP_RULE_BLOCK is appended
      const updatedContent = await readFile(rulePath, "utf-8");
      expect(updatedContent).toBe(
        `${originalContent.trimEnd()}\n\n${JP_RULE_BLOCK}\n`,
      );
    });

    it("prevents double-appending and does not create extra backups when already installed", async () => {
      const app = createApp();

      // First install
      const firstRes = await app.request("/api/jp-rule", { method: "POST" });
      expect(firstRes.status).toBe(200);
      const afterFirst = await readFile(rulePath, "utf-8");

      // Second install (should be a no-op)
      const secondRes = await app.request("/api/jp-rule", { method: "POST" });
      const secondBody = await secondRes.json();

      expect(secondRes.status).toBe(200);
      expect(secondBody).toEqual({
        ok: true,
        alreadyInstalled: true,
        path: rulePath,
        backupPath: null,
      });

      const afterSecond = await readFile(rulePath, "utf-8");
      expect(afterSecond).toBe(afterFirst);

      // Ensure marker appears exactly once
      const matches = afterSecond.match(/<!-- antigravity-jp-rule:start -->/g);
      expect(matches).toHaveLength(1);

      // Ensure no .bak-* file was created on the second POST
      const entries = await readdir(dirname(rulePath));
      expect(entries.filter((name) => name.includes(".bak-"))).toHaveLength(0);
    });
  });
});
