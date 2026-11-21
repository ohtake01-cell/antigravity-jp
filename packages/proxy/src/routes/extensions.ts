/**
 * 拡張機能・カスタマイズ管理ルート
 *
 * Antigravity 本体が実際に読み込む ~/.gemini/config/ 配下を安全に管理する:
 * - MCP サーバー: ~/.gemini/config/mcp_config.json
 * - スキル: ~/.gemini/config/skills/<slug>/SKILL.md
 * - プラグイン: ~/.gemini/config/plugins/<name>/
 * - パーソナルメモリ: ~/.gemini/config/memories.json (GEMINI.md へ自動同期)
 * - グローバルルール: ~/.gemini/config/GEMINI.md
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Hono } from "hono";

const execFileAsync = promisify(execFile);

const MEMORY_BLOCK_START = "<!-- antigravity-memory:start -->";
const MEMORY_BLOCK_END = "<!-- antigravity-memory:end -->";

export interface McpServerEntry {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  headerKeys: string[];
  disabled: boolean;
}

export interface SkillEntry {
  slug: string;
  name: string;
  description: string;
  source: "user" | "plugin" | "builtin";
  pluginName?: string;
  path: string;
  editable: boolean;
  bodyPreview: string;
  body?: string;
}

export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  version?: string;
  path: string;
  skillCount: number;
  hasMcp: boolean;
  disabled: boolean;
}

export interface MemoryItem {
  id: string;
  title: string;
  content: string;
  category: "profile" | "preference" | "project" | "other";
  enabled: boolean;
  updatedAt: string;
}

interface RawMcpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  serverUrl?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  disabled?: boolean;
  [key: string]: unknown;
}

interface RawMcpConfigFile {
  mcpServers?: Record<string, RawMcpServerConfig>;
  [key: string]: unknown;
}

function getHomeBase(): string {
  return process.env.AG_JP_HOME_DIR?.trim() || homedir();
}

export function getExtensionPaths() {
  const home = getHomeBase();
  const configDir = join(home, ".gemini", "config");
  const builtinSkillsDir = join(home, ".gemini", "antigravity", "builtin", "skills");
  const legacyMcpPath = join(home, ".gemini", "antigravity", "mcp_config.json");
  const primaryMcpPath = join(configDir, "mcp_config.json");
  const mcpConfigPath =
    existsSync(primaryMcpPath) || !existsSync(legacyMcpPath)
      ? primaryMcpPath
      : legacyMcpPath;

  const primaryRulesPath = join(configDir, "GEMINI.md");
  const legacyRulesPath = join(home, ".gemini", "GEMINI.md");
  const rulesPath =
    existsSync(primaryRulesPath) || !existsSync(legacyRulesPath)
      ? primaryRulesPath
      : legacyRulesPath;

  return {
    configDir,
    mcpConfigPath,
    skillsDir: join(configDir, "skills"),
    pluginsDir: join(configDir, "plugins"),
    builtinSkillsDir,
    memoriesPath: join(configDir, "memories.json"),
    rulesPath,
  };
}

export function sanitizeSlug(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, 64);
}

function assertSafeSingleSegment(name: string): string {
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new Error("不正な名前が指定されました");
  }
  return trimmed;
}

function parseSkillMarkdown(raw: string, fallbackSlug: string): {
  name: string;
  description: string;
  body: string;
} {
  let name = fallbackSlug;
  let description = "";
  let body = raw;

  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fmMatch) {
    const fm = fmMatch[1] ?? "";
    body = fmMatch[2] ?? "";
    const lines = fm.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const nameMatch = line.match(/^name:\s*(.+)$/);
      if (nameMatch) {
        name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
        continue;
      }
      const descMatch = line.match(/^description:\s*(.*)$/);
      if (descMatch) {
        const val = descMatch[1].trim();
        if (/^[>|][+-]?$/.test(val) || val === "") {
          // YAML folded/literal 複数行ブロック (例: description: >- / |)
          const blockLines: string[] = [];
          while (i + 1 < lines.length) {
            const next = lines[i + 1] ?? "";
            if (/^[ \t]+/.test(next)) {
              blockLines.push(next.trim());
              i++;
            } else if (next.trim() === "") {
              blockLines.push("");
              i++;
            } else {
              break;
            }
          }
          description = blockLines.join(" ").replace(/\s+/g, " ").trim();
        } else {
          description = val.replace(/^["']|["']$/g, "");
        }
      }
    }
  }
  return { name, description, body: body.trim() };
}

function buildSkillMarkdown(name: string, description: string, instructions: string): string {
  const safeName = name.replace(/\r?\n/g, " ").trim();
  const safeDesc = description.replace(/\r?\n/g, " ").trim();
  const escapedDesc = safeDesc.includes(":") ? JSON.stringify(safeDesc) : safeDesc;
  return `---\nname: ${safeName}\ndescription: ${escapedDesc}\n---\n\n${instructions.trim()}\n`;
}

function readMcpConfigFile(mcpPath: string): RawMcpConfigFile {
  if (!existsSync(mcpPath)) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(readFileSync(mcpPath, "utf-8")) as RawMcpConfigFile;
    if (!parsed || typeof parsed !== "object") return { mcpServers: {} };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
      parsed.mcpServers = {};
    }
    return parsed;
  } catch {
    return { mcpServers: {} };
  }
}

function writeMcpConfigFile(mcpPath: string, data: RawMcpConfigFile): void {
  mkdirSync(resolve(mcpPath, ".."), { recursive: true });
  writeFileSync(mcpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function listMcpServers(mcpPath: string): McpServerEntry[] {
  const cfg = readMcpConfigFile(mcpPath);
  const servers = cfg.mcpServers ?? {};
  return Object.entries(servers).map(([name, entry]) => {
    const url =
      typeof entry.url === "string"
        ? entry.url
        : typeof entry.serverUrl === "string"
          ? entry.serverUrl
          : undefined;
    return {
      name,
      transport: url ? "http" : "stdio",
      command: typeof entry.command === "string" ? entry.command : undefined,
      args: Array.isArray(entry.args)
        ? entry.args.filter((a): a is string => typeof a === "string")
        : undefined,
      url,
      envKeys:
        entry.env && typeof entry.env === "object"
          ? Object.keys(entry.env)
          : [],
      headerKeys:
        entry.headers && typeof entry.headers === "object"
          ? Object.keys(entry.headers)
          : [],
      disabled: entry.disabled === true,
    };
  });
}

function scanSkillsDirectory(
  dir: string,
  source: SkillEntry["source"],
  pluginName?: string,
): SkillEntry[] {
  if (!existsSync(dir)) return [];
  const results: SkillEntry[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const slug of entries) {
    if (slug.startsWith(".")) continue;
    const skillDir = join(dir, slug);
    const skillMd = join(skillDir, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    try {
      const raw = readFileSync(skillMd, "utf-8");
      const parsed = parseSkillMarkdown(raw, slug);
      results.push({
        slug,
        name: parsed.name || slug,
        description: parsed.description || "",
        source,
        pluginName,
        path: skillMd,
        editable: source === "user",
        bodyPreview: parsed.body.slice(0, 220),
        body: source === "user" ? parsed.body : undefined,
      });
    } catch {
      // 読み込み失敗はスキップ
    }
  }
  return results;
}

function listPlugins(pluginsDir: string): {
  plugins: PluginEntry[];
  pluginSkills: SkillEntry[];
} {
  if (!existsSync(pluginsDir)) return { plugins: [], pluginSkills: [] };
  const plugins: PluginEntry[] = [];
  const pluginSkills: SkillEntry[] = [];
  let entries: string[];
  try {
    entries = readdirSync(pluginsDir);
  } catch {
    return { plugins: [], pluginSkills: [] };
  }

  for (const dirName of entries) {
    if (dirName.startsWith(".")) continue;
    const pluginPath = join(pluginsDir, dirName);
    try {
      if (!statSync(pluginPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const disabled = dirName.endsWith(".disabled");
    const cleanId = disabled ? dirName.replace(/\.disabled$/, "") : dirName;

    let name = cleanId;
    let description = "";
    let version: string | undefined;

    const manifestCandidates = [
      join(pluginPath, "plugin.json"),
      join(pluginPath, ".claude-plugin", "plugin.json"),
      join(pluginPath, "package.json"),
    ];
    for (const mf of manifestCandidates) {
      if (!existsSync(mf)) continue;
      try {
        const parsed = JSON.parse(readFileSync(mf, "utf-8")) as {
          name?: string;
          description?: string;
          version?: string;
        };
        if (parsed.name) name = parsed.name;
        if (parsed.description) description = parsed.description;
        if (parsed.version) version = parsed.version;
        break;
      } catch {
        // 次の候補を確認
      }
    }

    const skillsInPlugin = scanSkillsDirectory(
      join(pluginPath, "skills"),
      "plugin",
      name,
    );
    if (!disabled) {
      pluginSkills.push(...skillsInPlugin);
    }

    const hasMcp =
      existsSync(join(pluginPath, "mcp.json")) ||
      existsSync(join(pluginPath, ".claude-plugin", "mcp.json")) ||
      existsSync(join(pluginPath, "mcp_config.json"));

    plugins.push({
      id: cleanId,
      name,
      description,
      version,
      path: pluginPath,
      skillCount: skillsInPlugin.length,
      hasMcp,
      disabled,
    });
  }

  return { plugins, pluginSkills };
}

function readMemories(memoriesPath: string): MemoryItem[] {
  if (!existsSync(memoriesPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(memoriesPath, "utf-8")) as {
      memories?: MemoryItem[];
    };
    return Array.isArray(parsed.memories) ? parsed.memories : [];
  } catch {
    return [];
  }
}

function stripMemoryBlock(raw: string): string {
  const re = new RegExp(
    `\\n?${MEMORY_BLOCK_START}[\\s\\S]*?${MEMORY_BLOCK_END}\\n?`,
    "g",
  );
  return raw.replace(re, "\n").trim();
}

function buildMemoryMarkdownBlock(memories: MemoryItem[]): string {
  const active = memories.filter((m) => m.enabled && m.content.trim());
  if (active.length === 0) return "";
  const lines = [
    MEMORY_BLOCK_START,
    "## パーソナルメモリ（ユーザー設定・好み）",
    ...active.map((m) =>
      m.title.trim()
        ? `- **${m.title.trim()}**: ${m.content.trim()}`
        : `- ${m.content.trim()}`,
    ),
    MEMORY_BLOCK_END,
  ];
  return lines.join("\n");
}

function syncMemoriesToRulesFile(rulesPath: string, memories: MemoryItem[]): void {
  mkdirSync(resolve(rulesPath, ".."), { recursive: true });
  const existing = existsSync(rulesPath) ? readFileSync(rulesPath, "utf-8") : "";
  const userPart = stripMemoryBlock(existing);
  const memBlock = buildMemoryMarkdownBlock(memories);
  const combined = [userPart, memBlock].filter(Boolean).join("\n\n");
  writeFileSync(rulesPath, combined ? `${combined}\n` : "", "utf-8");
}

function writeMemories(
  memoriesPath: string,
  rulesPath: string,
  memories: MemoryItem[],
): void {
  mkdirSync(resolve(memoriesPath, ".."), { recursive: true });
  writeFileSync(
    memoriesPath,
    JSON.stringify({ memories }, null, 2) + "\n",
    "utf-8",
  );
  syncMemoriesToRulesFile(rulesPath, memories);
}

function readGlobalRulesText(rulesPath: string): string {
  if (!existsSync(rulesPath)) return "";
  try {
    return stripMemoryBlock(readFileSync(rulesPath, "utf-8"));
  } catch {
    return "";
  }
}

function writeGlobalRulesText(
  rulesPath: string,
  memoriesPath: string,
  userRules: string,
): void {
  mkdirSync(resolve(rulesPath, ".."), { recursive: true });
  const memories = readMemories(memoriesPath);
  const memBlock = buildMemoryMarkdownBlock(memories);
  const combined = [userRules.trim(), memBlock].filter(Boolean).join("\n\n");
  writeFileSync(rulesPath, combined ? `${combined}\n` : "", "utf-8");
}

export function registerExtensionRoutes(app: Hono): void {
  // 一覧取得（MCP・スキル・プラグイン・メモリ・グローバルルール）
  app.get("/api/extensions/overview", (c) => {
    const paths = getExtensionPaths();
    const mcpServers = listMcpServers(paths.mcpConfigPath);
    const userSkills = scanSkillsDirectory(paths.skillsDir, "user");
    const { plugins, pluginSkills } = listPlugins(paths.pluginsDir);
    const builtinSkills = scanSkillsDirectory(paths.builtinSkillsDir, "builtin");
    const memories = readMemories(paths.memoriesPath);
    const globalRules = readGlobalRulesText(paths.rulesPath);

    return c.json({
      ok: true,
      mcpServers,
      skills: [...userSkills, ...pluginSkills, ...builtinSkills],
      plugins,
      memories,
      globalRules,
      paths: {
        mcpConfigPath: paths.mcpConfigPath,
        skillsDir: paths.skillsDir,
        pluginsDir: paths.pluginsDir,
        rulesPath: paths.rulesPath,
      },
    });
  });

  // MCP サーバー追加・更新
  app.post("/api/extensions/mcp", async (c) => {
    try {
      const body = (await c.req.json()) as {
        name?: string;
        transport?: "stdio" | "http";
        command?: string;
        args?: string[];
        url?: string;
        env?: Record<string, string>;
        headers?: Record<string, string>;
        disabled?: boolean;
      };
      const name = assertSafeSingleSegment(body.name ?? "");
      const paths = getExtensionPaths();
      const cfg = readMcpConfigFile(paths.mcpConfigPath);
      const existing = cfg.mcpServers?.[name] ?? {};

      const nextEntry: RawMcpServerConfig = {
        ...existing,
        disabled: body.disabled === true,
      };
      if (body.transport === "http" || (body.url && body.url.trim())) {
        const url = (body.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) {
          return c.json({ error: "URL は http:// または https:// で始めてください" }, 400);
        }
        delete nextEntry.command;
        delete nextEntry.args;
        nextEntry.url = url;
        if (body.headers && Object.keys(body.headers).length > 0) {
          nextEntry.headers = { ...(existing.headers ?? {}), ...body.headers };
        }
      } else {
        const command = (body.command ?? "").trim();
        if (!command) {
          return c.json({ error: "実行コマンド（例: npx）を入力してください" }, 400);
        }
        delete nextEntry.url;
        delete nextEntry.serverUrl;
        nextEntry.command = command;
        nextEntry.args = Array.isArray(body.args)
          ? body.args.map((a) => String(a))
          : [];
        if (body.env && Object.keys(body.env).length > 0) {
          nextEntry.env = { ...(existing.env ?? {}), ...body.env };
        }
      }

      cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: nextEntry };
      writeMcpConfigFile(paths.mcpConfigPath, cfg);
      return c.json({ ok: true, mcpServers: listMcpServers(paths.mcpConfigPath) });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "MCP の保存に失敗しました" },
        400,
      );
    }
  });

  // MCP サーバー有効/無効トグル
  app.patch("/api/extensions/mcp/:name", async (c) => {
    try {
      const name = assertSafeSingleSegment(c.req.param("name"));
      const body = (await c.req.json()) as { disabled?: boolean };
      const paths = getExtensionPaths();
      const cfg = readMcpConfigFile(paths.mcpConfigPath);
      if (!cfg.mcpServers?.[name]) {
        return c.json({ error: `MCP サーバー「${name}」が見つかりません` }, 404);
      }
      cfg.mcpServers[name] = {
        ...cfg.mcpServers[name],
        disabled: Boolean(body.disabled),
      };
      writeMcpConfigFile(paths.mcpConfigPath, cfg);
      return c.json({ ok: true, mcpServers: listMcpServers(paths.mcpConfigPath) });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "更新に失敗しました" },
        400,
      );
    }
  });

  // MCP サーバー削除
  app.delete("/api/extensions/mcp/:name", (c) => {
    try {
      const name = assertSafeSingleSegment(c.req.param("name"));
      const paths = getExtensionPaths();
      const cfg = readMcpConfigFile(paths.mcpConfigPath);
      if (cfg.mcpServers && name in cfg.mcpServers) {
        delete cfg.mcpServers[name];
        writeMcpConfigFile(paths.mcpConfigPath, cfg);
      }
      return c.json({ ok: true, mcpServers: listMcpServers(paths.mcpConfigPath) });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "削除に失敗しました" },
        400,
      );
    }
  });

  // ユーザースキル作成・編集
  app.post("/api/extensions/skills", async (c) => {
    try {
      const body = (await c.req.json()) as {
        slug?: string;
        name?: string;
        description?: string;
        instructions?: string;
      };
      const name = (body.name ?? "").trim();
      const description = (body.description ?? "").trim();
      const instructions = (body.instructions ?? "").trim();
      if (!name || !instructions) {
        return c.json(
          { error: "スキル名と手順（内容）は必須です" },
          400,
        );
      }
      const slug =
        sanitizeSlug(body.slug || name) || `skill-${Date.now().toString(36)}`;
      const paths = getExtensionPaths();
      const targetDir = join(paths.skillsDir, slug);
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(
        join(targetDir, "SKILL.md"),
        buildSkillMarkdown(name, description || `${name} に関する作業手順`, instructions),
        "utf-8",
      );
      return c.json({
        ok: true,
        slug,
        skills: scanSkillsDirectory(paths.skillsDir, "user"),
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "スキルの保存に失敗しました" },
        400,
      );
    }
  });

  // ユーザースキル削除（builtin / plugin は保護）
  app.delete("/api/extensions/skills/:slug", (c) => {
    try {
      const slug = assertSafeSingleSegment(c.req.param("slug"));
      const paths = getExtensionPaths();
      const targetDir = resolve(paths.skillsDir, slug);
      if (!targetDir.startsWith(resolve(paths.skillsDir) + sep)) {
        return c.json({ error: "不正なパスです" }, 400);
      }
      if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "削除に失敗しました" },
        400,
      );
    }
  });

  // プラグイン／スキルのローカルまたは GitHub URL 導入
  app.post("/api/extensions/plugins/install", async (c) => {
    try {
      const body = (await c.req.json()) as { source?: string };
      const source = (body.source ?? "").trim();
      if (!source) {
        return c.json(
          { error: "GitHub URL またはローカルフォルダパスを入力してください" },
          400,
        );
      }
      const paths = getExtensionPaths();
      const isGitUrl = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/i.test(
        source,
      );

      if (isGitUrl) {
        const repoName = sanitizeSlug(
          basename(source.replace(/\/+$/, "").replace(/\.git$/i, "")),
        );
        if (!repoName) {
          return c.json({ error: "リポジトリ名を判定できませんでした" }, 400);
        }
        mkdirSync(paths.pluginsDir, { recursive: true });
        const tempTarget = join(paths.pluginsDir, repoName);
        if (existsSync(tempTarget)) {
          return c.json(
            { error: `「${repoName}」はすでに導入済みです` },
            409,
          );
        }
        await execFileAsync(
          "git",
          ["clone", "--depth", "1", source, tempTarget],
          { timeout: 60_000 },
        );
        // 単体スキルリポジトリ（ルートに SKILL.md があり plugin.json が無い）なら skills/ へ移動
        if (
          existsSync(join(tempTarget, "SKILL.md")) &&
          !existsSync(join(tempTarget, "plugin.json")) &&
          !existsSync(join(tempTarget, ".claude-plugin", "plugin.json"))
        ) {
          mkdirSync(paths.skillsDir, { recursive: true });
          const skillDest = join(paths.skillsDir, repoName);
          cpSync(tempTarget, skillDest, { recursive: true });
          rmSync(tempTarget, { recursive: true, force: true });
          return c.json({ ok: true, installedAs: "skill", name: repoName });
        }
        return c.json({ ok: true, installedAs: "plugin", name: repoName });
      }

      // ローカルフォルダパスからのコピー導入
      const expanded = source.startsWith("~/")
        ? join(getHomeBase(), source.slice(2))
        : source;
      const absSource = resolve(expanded);
      if (!existsSync(absSource) || !statSync(absSource).isDirectory()) {
        return c.json(
          {
            error:
              "指定されたローカルフォルダが見つからないか、GitHub URL (https://github.com/owner/repo) 形式ではありません",
          },
          400,
        );
      }
      const slug = sanitizeSlug(basename(absSource)) || `ext-${Date.now().toString(36)}`;
      if (
        existsSync(join(absSource, "SKILL.md")) &&
        !existsSync(join(absSource, "plugin.json"))
      ) {
        mkdirSync(paths.skillsDir, { recursive: true });
        const dest = join(paths.skillsDir, slug);
        cpSync(absSource, dest, { recursive: true });
        return c.json({ ok: true, installedAs: "skill", name: slug });
      }
      mkdirSync(paths.pluginsDir, { recursive: true });
      const dest = join(paths.pluginsDir, slug);
      cpSync(absSource, dest, { recursive: true });
      return c.json({ ok: true, installedAs: "plugin", name: slug });
    } catch (err) {
      return c.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "プラグイン／スキルの導入に失敗しました",
        },
        400,
      );
    }
  });

  // プラグイン削除
  app.delete("/api/extensions/plugins/:id", (c) => {
    try {
      const id = assertSafeSingleSegment(c.req.param("id"));
      const paths = getExtensionPaths();
      const targetDir = resolve(paths.pluginsDir, id);
      if (!targetDir.startsWith(resolve(paths.pluginsDir) + sep)) {
        return c.json({ error: "不正なパスです" }, 400);
      }
      if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "削除に失敗しました" },
        400,
      );
    }
  });

  // パーソナルメモリ追加・更新
  app.post("/api/extensions/memories", async (c) => {
    try {
      const body = (await c.req.json()) as {
        id?: string;
        title?: string;
        content?: string;
        category?: MemoryItem["category"];
        enabled?: boolean;
      };
      const content = (body.content ?? "").trim();
      if (!content) {
        return c.json({ error: "記憶させる内容を入力してください" }, 400);
      }
      const paths = getExtensionPaths();
      const list = readMemories(paths.memoriesPath);
      const now = new Date().toISOString();
      const category: MemoryItem["category"] =
        body.category === "profile" ||
        body.category === "preference" ||
        body.category === "project" ||
        body.category === "other"
          ? body.category
          : "preference";

      if (body.id) {
        const idx = list.findIndex((m) => m.id === body.id);
        if (idx >= 0) {
          list[idx] = {
            ...list[idx],
            title: (body.title ?? list[idx].title).trim(),
            content,
            category,
            enabled: body.enabled ?? list[idx].enabled,
            updatedAt: now,
          };
          writeMemories(paths.memoriesPath, paths.rulesPath, list);
          return c.json({ ok: true, memories: list });
        }
      }

      const item: MemoryItem = {
        id: randomUUID(),
        title: (body.title ?? "").trim() || "メモ",
        content,
        category,
        enabled: body.enabled ?? true,
        updatedAt: now,
      };
      const next = [item, ...list];
      writeMemories(paths.memoriesPath, paths.rulesPath, next);
      return c.json({ ok: true, memory: item, memories: next });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "メモリの保存に失敗しました" },
        400,
      );
    }
  });

  // パーソナルメモリ有効/無効切替
  app.patch("/api/extensions/memories/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const body = (await c.req.json()) as Partial<MemoryItem>;
      const paths = getExtensionPaths();
      const list = readMemories(paths.memoriesPath);
      const idx = list.findIndex((m) => m.id === id);
      if (idx < 0) {
        return c.json({ error: "指定されたメモリが見つかりません" }, 404);
      }
      list[idx] = {
        ...list[idx],
        ...(typeof body.title === "string" ? { title: body.title.trim() } : {}),
        ...(typeof body.content === "string" ? { content: body.content.trim() } : {}),
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        updatedAt: new Date().toISOString(),
      };
      writeMemories(paths.memoriesPath, paths.rulesPath, list);
      return c.json({ ok: true, memories: list });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "更新に失敗しました" },
        400,
      );
    }
  });

  // パーソナルメモリ削除
  app.delete("/api/extensions/memories/:id", (c) => {
    const id = c.req.param("id");
    const paths = getExtensionPaths();
    const next = readMemories(paths.memoriesPath).filter((m) => m.id !== id);
    writeMemories(paths.memoriesPath, paths.rulesPath, next);
    return c.json({ ok: true, memories: next });
  });

  // グローバルルール更新（メモリ自動同期ブロックは保護）
  app.put("/api/extensions/rules", async (c) => {
    try {
      const body = (await c.req.json()) as { content?: string };
      const paths = getExtensionPaths();
      writeGlobalRulesText(paths.rulesPath, paths.memoriesPath, body.content ?? "");
      return c.json({
        ok: true,
        globalRules: readGlobalRulesText(paths.rulesPath),
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "ルールの保存に失敗しました" },
        400,
      );
    }
  });
}
