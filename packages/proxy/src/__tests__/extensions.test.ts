import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { registerExtensionRoutes, sanitizeSlug } from "../routes/extensions.js";

describe("extension routes (MCP, Skills, Plugins, Memories, Global Rules)", () => {
  let tempHome: string;
  let prevHomeEnv: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "ag-ext-test-"));
    prevHomeEnv = process.env.AG_JP_HOME_DIR;
    process.env.AG_JP_HOME_DIR = tempHome;
  });

  afterEach(() => {
    if (prevHomeEnv === undefined) delete process.env.AG_JP_HOME_DIR;
    else process.env.AG_JP_HOME_DIR = prevHomeEnv;
    rmSync(tempHome, { recursive: true, force: true });
  });

  function createApp() {
    const app = new Hono();
    registerExtensionRoutes(app);
    return app;
  }

  it("manages MCP servers (add stdio/http, toggle disabled, delete)", async () => {
    const app = createApp();
    const addRes = await app.request("/api/extensions/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      }),
    });
    expect(addRes.status).toBe(200);
    const added = await addRes.json();
    expect(added.mcpServers).toHaveLength(1);
    expect(added.mcpServers[0].name).toBe("filesystem");
    expect(added.mcpServers[0].disabled).toBe(false);

    const toggleRes = await app.request("/api/extensions/mcp/filesystem", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    expect(toggleRes.status).toBe(200);
    const toggled = await toggleRes.json();
    expect(toggled.mcpServers[0].disabled).toBe(true);

    const delRes = await app.request("/api/extensions/mcp/filesystem", {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    const deleted = await delRes.json();
    expect(deleted.mcpServers).toHaveLength(0);
  });

  it("creates, lists, and deletes user skills with valid SKILL.md frontmatter", async () => {
    const app = createApp();
    const res = await app.request("/api/extensions/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "code-review-jp",
        name: "日本語コードレビュー",
        description: "PRのレビューを丁寧な日本語で行う",
        instructions: "1. バグを最優先で確認する\n2. 簡潔に提案する",
      }),
    });
    expect(res.status).toBe(200);

    const skillMdPath = join(
      tempHome,
      ".gemini",
      "config",
      "skills",
      "code-review-jp",
      "SKILL.md",
    );
    expect(existsSync(skillMdPath)).toBe(true);
    const md = readFileSync(skillMdPath, "utf-8");
    expect(md).toContain("name: 日本語コードレビュー");
    expect(md).toContain("1. バグを最優先で確認する");

    const overviewRes = await app.request("/api/extensions/overview");
    const overview = await overviewRes.json();
    expect(overview.skills.some((s: { slug: string }) => s.slug === "code-review-jp")).toBe(true);

    const delRes = await app.request("/api/extensions/skills/code-review-jp", {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    expect(existsSync(skillMdPath)).toBe(false);
  });

  it("syncs personal memories into GEMINI.md without overwriting user global rules", async () => {
    const app = createApp();
    const ruleRes = await app.request("/api/extensions/rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# マイ共通ルール\n- 返答は簡潔に" }),
    });
    expect(ruleRes.status).toBe(200);

    const memRes = await app.request("/api/extensions/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "好きなエディタ",
        content: "TypeScript と React をよく使う",
        category: "preference",
      }),
    });
    expect(memRes.status).toBe(200);

    const geminiMd = readFileSync(
      join(tempHome, ".gemini", "config", "GEMINI.md"),
      "utf-8",
    );
    expect(geminiMd).toContain("# マイ共通ルール");
    expect(geminiMd).toContain("<!-- antigravity-memory:start -->");
    expect(geminiMd).toContain("TypeScript と React をよく使う");

    // Re-updating global rules keeps the memory block intact
    await app.request("/api/extensions/rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# 更新後ルール" }),
    });
    const geminiMdAfter = readFileSync(
      join(tempHome, ".gemini", "config", "GEMINI.md"),
      "utf-8",
    );
    expect(geminiMdAfter).toContain("# 更新後ルール");
    expect(geminiMdAfter).toContain("TypeScript と React をよく使う");
  });

  it("installs a local skill folder and rejects unsafe path traversal names", async () => {
    const app = createApp();
    const srcDir = join(tempHome, "my-local-skill");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "SKILL.md"),
      "---\nname: local-demo\ndescription: demo\n---\n\n手順書",
    );

    const installRes = await app.request("/api/extensions/plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: srcDir }),
    });
    expect(installRes.status).toBe(200);
    const installed = await installRes.json();
    expect(installed.installedAs).toBe("skill");

    const badDel = await app.request("/api/extensions/mcp/..%2Fevil", {
      method: "DELETE",
    });
    expect(badDel.status).toBe(400);
    expect(sanitizeSlug("Hello World!! 123")).toBe("hello-world-123");
  });

  it("parses YAML folded/literal multiline skill descriptions cleanly", async () => {
    const app = createApp();
    const skillDir = join(tempHome, ".gemini", "config", "skills", "yaml-multiline");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: yaml-multiline\ndescription: >-\n  複数行にまたがる\n  YAML 説明文のテスト\n---\n\n本文\n",
    );

    const overviewRes = await app.request("/api/extensions/overview");
    expect(overviewRes.status).toBe(200);
    const overview = await overviewRes.json();
    const found = overview.skills.find(
      (s: { slug: string }) => s.slug === "yaml-multiline",
    );
    expect(found).toBeDefined();
    expect(found.description).toBe("複数行にまたがる YAML 説明文のテスト");
  });
});
