/**
 * /api/providers/* routes — Generic Multi-AI Account Detection, Official CLI OAuth Login,
 * and Multi-AI Worker Sessions (OpenAI Codex / Anthropic Claude / Local Ollama).
 *
 * Designed for the Unified Edition (Lite = Gemini-only, Pro = Multi-AI & Command Hub)
 * with zero hardcoded private paths, IPs, or personal environment details.
 */

import type { Hono } from "hono";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { discovery } from "../routing.js";
import { fetchMergedLSModels } from "./models.js";

const execFileAsync = promisify(execFile);

export type ExternalProviderId = "openai" | "anthropic" | "ollama";
export type UnifiedProviderId = "google" | ExternalProviderId;

export type ProviderConnectionStatus =
  | "ready"
  | "needs_login"
  | "not_installed"
  | "offline";

export interface ProviderModelItem {
  id: string;
  label: string;
}

export interface ProviderAccountInfo {
  id: UnifiedProviderId;
  name: string;
  company: string;
  description: string;
  status: ProviderConnectionStatus;
  installed: boolean;
  authenticated: boolean;
  accountHint?: string | null;
  activeModel?: string | null;
  models: ProviderModelItem[];
  supportsOfficialLogin: boolean;
  loginCommand?: string;
  installCommand?: string;
  loginHint?: string;
}

export interface MultiAIMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  error?: boolean;
}

export interface MultiAISession {
  id: string;
  provider: ExternalProviderId;
  title: string;
  model: string | null;
  status: "idle" | "running" | "error";
  workspaceDir?: string;
  sourceChatId?: string;
  sourceChatTitle?: string;
  createdAt: string;
  updatedAt: string;
  messages: MultiAIMessage[];
}

export interface LocalExtensionItem {
  id: string;
  name: string;
  description?: string;
  url?: string;
  enabled?: boolean;
}

const PROVIDERS_CACHE_TTL_MS = 15_000;
let cachedProviders: {
  fetchedAt: number;
  providers: ProviderAccountInfo[];
  extensions: LocalExtensionItem[];
} | null = null;

const SESSIONS_PATH = join(
  homedir(),
  ".gemini",
  "antigravity",
  "jp-multi-ai-sessions.json",
);
const EXTENSIONS_PATH = join(
  homedir(),
  ".config",
  "antigravity-jp",
  "extensions.json",
);

const MAX_SESSIONS = 40;
let sessionsLoaded = false;
const sessionsMap = new Map<string, MultiAISession>();

function buildCandidateBinPaths(binName: string): string[] {
  const home = homedir();
  const candidates = [
    join(home, ".local", "bin", binName),
    `/opt/homebrew/bin/${binName}`,
    `/usr/local/bin/${binName}`,
    join(home, ".npm-global", "bin", binName),
    join(home, ".volta", "bin", binName),
    join(home, ".asdf", "shims", binName),
    join(home, ".fnm", "current", "bin", binName),
    join(home, ".bun", "bin", binName),
  ];

  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (dir) candidates.push(join(dir, binName));
  }
  return Array.from(new Set(candidates));
}

export function findCliBinary(binName: string): string | null {
  for (const p of buildCandidateBinPaths(binName)) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

function buildAugmentedEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const extraPaths = [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
  ];
  const current = process.env.PATH ?? "";
  const merged = Array.from(
    new Set([...extraPaths, ...current.split(":").filter(Boolean)]),
  ).join(":");
  return { ...process.env, PATH: merged };
}

async function runCliCheck(
  binPath: string,
  args: string[],
  timeoutMs = 3_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, args, {
      timeout: timeoutMs,
      env: buildAugmentedEnv(),
      maxBuffer: 512 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: String(e.stdout ?? "").trim(),
      stderr: String(e.stderr ?? "").trim(),
    };
  }
}

async function detectGoogleProvider(): Promise<ProviderAccountInfo> {
  try {
    const [instances, modelsRes] = await Promise.all([
      discovery.getInstances(false).catch(() => []),
      fetchMergedLSModels().catch(() => ({
        clientModelConfigs: [],
        defaultOverrideModelConfig: undefined,
      })),
    ]);
    const configs = modelsRes.clientModelConfigs ?? [];
    const models: ProviderModelItem[] = configs
      .map((m) => ({
        id: m.modelOrAlias?.model ?? "",
        label: m.label ?? m.modelOrAlias?.model ?? "",
      }))
      .filter((m) => m.id);
    const defaultId =
      modelsRes.defaultOverrideModelConfig?.modelOrAlias?.model;
    const activeModel =
      models.find((m) => m.id === defaultId)?.label ?? models[0]?.label ?? null;
    const healthy = instances.length > 0 && models.length > 0;
    return {
      id: "google",
      name: "Gemini (Antigravity)",
      company: "Google",
      description: "Antigravity 本家ログインと直結する標準モデル（下位・上位共通）",
      status: healthy ? "ready" : "offline",
      installed: instances.length > 0,
      authenticated: healthy,
      accountHint: healthy ? `${models.length}モデル利用可能` : null,
      activeModel,
      models,
      supportsOfficialLogin: false,
      loginHint: "本家 Antigravity アプリにログインすると自動連携します",
    };
  } catch {
    return {
      id: "google",
      name: "Gemini (Antigravity)",
      company: "Google",
      description: "Antigravity 本家ログインと直結する標準モデル（下位・上位共通）",
      status: "offline",
      installed: false,
      authenticated: false,
      models: [],
      supportsOfficialLogin: false,
    };
  }
}

async function readCodexLocalModels(): Promise<{
  activeModel: string | null;
  models: ProviderModelItem[];
}> {
  const home = homedir();
  let activeModel: string | null = null;
  const models: ProviderModelItem[] = [];
  const seen = new Set<string>();

  try {
    const cfgRaw = await readFile(join(home, ".codex", "config.toml"), "utf-8");
    const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(cfgRaw);
    if (m?.[1]) activeModel = m[1].trim();
  } catch {
    // optional
  }

  try {
    const cacheRaw = await readFile(
      join(home, ".codex", "models_cache.json"),
      "utf-8",
    );
    const parsed = JSON.parse(cacheRaw) as {
      models?: Array<{ slug?: string; id?: string; display_name?: string }>;
    };
    for (const item of parsed.models ?? []) {
      const id = (item.slug || item.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: item.display_name?.trim() || id });
    }
  } catch {
    // optional
  }

  if (activeModel && !seen.has(activeModel)) {
    models.unshift({ id: activeModel, label: activeModel });
  }
  if (models.length === 0) {
    models.push(
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { id: "o3", label: "o3" },
    );
  }
  return { activeModel: activeModel ?? models[0]?.id ?? null, models };
}

async function detectOpenAIProvider(): Promise<ProviderAccountInfo> {
  const bin = findCliBinary("codex");
  const { activeModel, models } = await readCodexLocalModels();
  if (!bin) {
    return {
      id: "openai",
      name: "OpenAI / ChatGPT (Codex)",
      company: "OpenAI",
      description:
        "ChatGPT Plus / Pro のサブスク枠を使って Codex CLI 経由で対話・コード実行できます",
      status: "not_installed",
      installed: false,
      authenticated: false,
      activeModel,
      models,
      supportsOfficialLogin: true,
      loginCommand: "codex login",
      installCommand: "npm install -g @openai/codex",
      loginHint: "公式 Codex CLI を入れてブラウザログインすると追加課金なしで連携できます",
    };
  }

  let authenticated = Boolean(process.env.OPENAI_API_KEY?.trim());
  let accountHint: string | null = authenticated ? "APIキー設定済み" : null;

  if (!authenticated) {
    try {
      const authRaw = await readFile(
        join(homedir(), ".codex", "auth.json"),
        "utf-8",
      );
      const parsed = JSON.parse(authRaw) as Record<string, unknown>;
      if (parsed.tokens || parsed.OPENAI_API_KEY || parsed.access_token) {
        authenticated = true;
        accountHint = "ChatGPT ログイン済み";
      }
    } catch {
      // fallback to CLI status
    }
  }

  if (!authenticated && !process.env.VITEST) {
    const res = await runCliCheck(bin, ["login", "status"], 3_000);
    const out = `${res.stdout} ${res.stderr}`.toLowerCase();
    if (res.ok && (out.includes("logged in") || out.includes("chatgpt"))) {
      authenticated = true;
      accountHint = res.stdout.split("\n")[0]?.slice(0, 48) || "ログイン済み";
    }
  }

  return {
    id: "openai",
    name: "OpenAI / ChatGPT (Codex)",
    company: "OpenAI",
    description:
      "ChatGPT Plus / Pro のサブスク枠を使って Codex CLI 経由で対話・コード実行できます",
    status: authenticated ? "ready" : "needs_login",
    installed: true,
    authenticated,
    accountHint,
    activeModel,
    models,
    supportsOfficialLogin: true,
    loginCommand: "codex login",
    installCommand: "npm install -g @openai/codex",
    loginHint: "ボタンを押すと公式 OpenAI ブラウザログイン画面が開きます",
  };
}

async function detectAnthropicProvider(): Promise<ProviderAccountInfo> {
  const bin = findCliBinary("claude");
  const defaultModels: ProviderModelItem[] = [
    { id: "sonnet", label: "Claude Sonnet (標準)" },
    { id: "opus", label: "Claude Opus (高精度)" },
    { id: "haiku", label: "Claude Haiku (高速)" },
  ];

  if (!bin) {
    return {
      id: "anthropic",
      name: "Anthropic / Claude (Claude Code)",
      company: "Anthropic",
      description:
        "Claude Pro / Max のサブスク枠を使って Claude Code CLI 経由で対話・設計できます",
      status: "not_installed",
      installed: false,
      authenticated: false,
      activeModel: "sonnet",
      models: defaultModels,
      supportsOfficialLogin: true,
      loginCommand: "claude auth login",
      installCommand: "npm install -g @anthropic-ai/claude-code",
      loginHint: "公式 Claude Code CLI を入れてブラウザログインすると連携できます",
    };
  }

  let authenticated = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  let accountHint: string | null = authenticated ? "APIキー設定済み" : null;

  if (!authenticated) {
    try {
      const claudeJsonRaw = await readFile(join(homedir(), ".claude.json"), "utf-8");
      const parsed = JSON.parse(claudeJsonRaw) as {
        oauthAccount?: { emailAddress?: string; displayName?: string };
      };
      if (parsed.oauthAccount) {
        authenticated = true;
        accountHint = "Claude アカウント連携済み";
      }
    } catch {
      // check credentials file or CLI status
    }
  }

  if (!authenticated && !process.env.VITEST) {
    const res = await runCliCheck(bin, ["auth", "status"], 3_000);
    const out = `${res.stdout} ${res.stderr}`.toLowerCase();
    if (
      res.ok &&
      (out.includes("logged in") ||
        out.includes('"loggedin":true') ||
        out.includes('"logged_in":true') ||
        out.includes("authenticated"))
    ) {
      authenticated = true;
      accountHint = "Claude ログイン済み";
    }
  }

  return {
    id: "anthropic",
    name: "Anthropic / Claude (Claude Code)",
    company: "Anthropic",
    description:
      "Claude Pro / Max のサブスク枠を使って Claude Code CLI 経由で対話・設計できます",
    status: authenticated ? "ready" : "needs_login",
    installed: true,
    authenticated,
    accountHint,
    activeModel: "sonnet",
    models: defaultModels,
    supportsOfficialLogin: true,
    loginCommand: "claude auth login",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    loginHint: "ボタンを押すと公式 Anthropic ブラウザログイン画面が開きます",
  };
}

async function detectOllamaProvider(): Promise<ProviderAccountInfo> {
  const baseUrl = (
    process.env.PORTA_OLLAMA_URL || "http://127.0.0.1:11434"
  ).replace(/\/+$/, "");
  const models: ProviderModelItem[] = [];
  let online = false;

  if (!process.env.VITEST) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    try {
      const res = await fetch(`${baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      if (res.ok) {
        online = true;
        const data = (await res.json()) as {
          models?: Array<{ name?: string }>;
        };
        for (const m of data.models ?? []) {
          if (m.name) {
            models.push({ id: m.name, label: m.name });
          }
        }
      }
    } catch {
      // Ollama not running locally
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: "ollama",
    name: "ローカル AI (Ollama)",
    company: "Local",
    description: "自分の Mac で動くローカル LLM（ログイン不要・通信量ゼロ）",
    status: online && models.length > 0 ? "ready" : "offline",
    installed: online,
    authenticated: online,
    accountHint: online
      ? models.length > 0
        ? `${models.length}モデル検出`
        : "起動中（モデル未取得）"
      : null,
    activeModel: models[0]?.id ?? null,
    models,
    supportsOfficialLogin: false,
    installCommand: "brew install ollama && ollama serve",
    loginHint: "ログイン不要。ローカルで Ollama を起動すると自動検出されます",
  };
}

async function loadLocalExtensions(): Promise<LocalExtensionItem[]> {
  try {
    const raw = await readFile(EXTENSIONS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { extensions?: LocalExtensionItem[] };
    if (!Array.isArray(parsed.extensions)) return [];
    return parsed.extensions.filter(
      (e) => e && typeof e.id === "string" && typeof e.name === "string",
    );
  } catch {
    return [];
  }
}

async function ensureSessionsLoaded(): Promise<void> {
  if (sessionsLoaded) return;
  sessionsLoaded = true;
  if (process.env.VITEST) return;
  try {
    const raw = await readFile(SESSIONS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as MultiAISession[];
    if (Array.isArray(parsed)) {
      for (const s of parsed.slice(0, MAX_SESSIONS)) {
        if (s?.id && s.provider) {
          // Reset any stale "running" status from a previous process exit
          sessionsMap.set(s.id, {
            ...s,
            status: s.status === "running" ? "idle" : s.status,
          });
        }
      }
    }
  } catch {
    // fresh start
  }
}

async function persistSessions(): Promise<void> {
  if (process.env.VITEST) return;
  try {
    const list = Array.from(sessionsMap.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_SESSIONS);
    await mkdir(join(SESSIONS_PATH, ".."), { recursive: true });
    await writeFile(SESSIONS_PATH, `${JSON.stringify(list, null, 2)}\n`, "utf-8");
  } catch {
    // non-fatal
  }
}

function buildConversationPrompt(session: MultiAISession): string {
  const history = session.messages.slice(-12);
  if (history.length <= 1) {
    return history[0]?.content ?? "";
  }
  const lines = history.map((m) =>
    m.role === "user"
      ? `ユーザー:\n${m.content}`
      : `アシスタント:\n${m.content}`,
  );
  return `${lines.join("\n\n---\n\n")}\n\n上記の会話の流れを踏まえて、最後のユーザーの質問に自然な日本語で簡潔に答えてください。`;
}

async function executeProviderTurn(session: MultiAISession): Promise<string> {
  const prompt = buildConversationPrompt(session);
  const cwd =
    session.workspaceDir && existsSync(session.workspaceDir)
      ? session.workspaceDir
      : homedir();

  if (session.provider === "ollama") {
    const baseUrl = (
      process.env.PORTA_OLLAMA_URL || "http://127.0.0.1:11434"
    ).replace(/\/+$/, "");
    const ollamaInfo = await detectOllamaProvider();
    const model = session.model || ollamaInfo.activeModel;
    if (!model) {
      throw new Error(
        "ローカル Ollama が起動していないか、モデルが見つかりません（`ollama serve` を確認してください）。",
      );
    }
    session.model = model;
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: session.messages.slice(-16).map((m) => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama API エラー (HTTP ${res.status})`);
    }
    const data = (await res.json()) as {
      message?: { content?: string };
      response?: string;
    };
    const text = (data.message?.content ?? data.response ?? "").trim();
    if (!text) throw new Error("Ollama から空の応答が返されました");
    return text;
  }

  if (session.provider === "openai") {
    const bin = findCliBinary("codex");
    if (!bin) {
      throw new Error(
        "Codex CLI が未インストールです。設定画面からインストール後にログインしてください。",
      );
    }
    const args = ["exec", "--skip-git-repo-check"];
    if (session.model) {
      args.push("-m", session.model);
    }
    args.push(prompt);
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      env: buildAugmentedEnv(),
    });
    const out = stdout.trim();
    if (out) return out;
    throw new Error(stderr.trim() || "Codex から応答を取得できませんでした");
  }

  if (session.provider === "anthropic") {
    const bin = findCliBinary("claude");
    if (!bin) {
      throw new Error(
        "Claude Code CLI が未インストールです。設定画面からインストール後にログインしてください。",
      );
    }
    const args = ["-p", prompt, "--output-format", "text"];
    if (session.model) {
      args.push("--model", session.model);
    }
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      env: buildAugmentedEnv(),
    });
    const out = stdout.trim();
    if (out) return out;
    throw new Error(stderr.trim() || "Claude から応答を取得できませんでした");
  }

  throw new Error(`未対応のプロバイダーです: ${session.provider}`);
}

function launchOfficialLoginInTerminal(
  provider: "openai" | "anthropic",
  binPath: string,
): { launched: boolean; command: string; message: string } {
  const loginArgs = provider === "openai" ? "login" : "auth login";
  const displayName =
    provider === "openai"
      ? "OpenAI (ChatGPT / Codex)"
      : "Anthropic (Claude Code)";
  const shellCmd = `"${binPath.replace(/"/g, '\\"')}" ${loginArgs}`;

  if (process.platform === "darwin") {
    // Launch macOS Terminal so interactive browser OAuth & TTY prompts complete cleanly
    const script = [
      'tell application "Terminal"',
      "activate",
      `do script "clear; echo '=== ${displayName} 公式ログイン ==='; echo 'ブラウザが開くのでアカウントでサインインしてください。完了後この画面を閉じてアプリ側で再確認を押してください。'; echo ''; ${shellCmd.replace(/"/g, '\\"')}"`,
      "end tell",
    ].join("\n");
    const child = spawn("osascript", ["-e", script], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return {
      launched: true,
      command: provider === "openai" ? "codex login" : "claude auth login",
      message: `${displayName} の公式ログインをターミナルで起動しました。ブラウザでサインイン後、「状態を再確認」を押してください。`,
    };
  }

  return {
    launched: false,
    command: provider === "openai" ? "codex login" : "claude auth login",
    message: `ターミナルで「${provider === "openai" ? "codex login" : "claude auth login"}」を実行してサインインしてください。`,
  };
}

export function registerProviderRoutes(app: Hono): void {
  // ── Detect all provider accounts & login states ──
  app.get("/api/providers", async (c) => {
    const force = c.req.query("refresh") === "1";
    const now = Date.now();
    if (
      !force &&
      cachedProviders &&
      now - cachedProviders.fetchedAt < PROVIDERS_CACHE_TTL_MS
    ) {
      return c.json({
        updatedAt: new Date(cachedProviders.fetchedAt).toISOString(),
        providers: cachedProviders.providers,
        extensions: cachedProviders.extensions,
      });
    }

    const [google, openai, anthropic, ollama, extensions] = await Promise.all([
      detectGoogleProvider(),
      detectOpenAIProvider(),
      detectAnthropicProvider(),
      detectOllamaProvider(),
      loadLocalExtensions(),
    ]);

    const providers = [google, openai, anthropic, ollama];
    cachedProviders = { fetchedAt: now, providers, extensions };
    return c.json({
      updatedAt: new Date(now).toISOString(),
      providers,
      extensions,
    });
  });

  // ── Trigger official browser OAuth login via CLI ──
  app.post("/api/providers/:id/login", async (c) => {
    const id = c.req.param("id");
    if (id !== "openai" && id !== "anthropic") {
      return c.json(
        { error: "公式CLIログインに対応しているのは openai / anthropic のみです" },
        400,
      );
    }

    const binName = id === "openai" ? "codex" : "claude";
    const binPath = findCliBinary(binName);
    if (!binPath) {
      const installCmd =
        id === "openai"
          ? "npm install -g @openai/codex"
          : "npm install -g @anthropic-ai/claude-code";
      return c.json(
        {
          ok: false,
          needsInstall: true,
          installCommand: installCmd,
          error: `${binName} CLI が見つかりません。先にターミナルで「${installCmd}」を実行してインストールしてください。`,
        },
        400,
      );
    }

    cachedProviders = null;
    const result = launchOfficialLoginInTerminal(id, binPath);
    return c.json({ ok: true, ...result });
  });

  // ── Multi-AI Sessions CRUD ──
  app.get("/api/providers/sessions", async (c) => {
    await ensureSessionsLoaded();
    const sessions = Array.from(sessionsMap.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    return c.json({ sessions });
  });

  app.post("/api/providers/sessions", async (c) => {
    await ensureSessionsLoaded();
    let body: {
      provider?: string;
      model?: string | null;
      prompt?: string;
      title?: string;
      workspaceDir?: string;
      sourceChatId?: string;
      sourceChatTitle?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const provider = body.provider;
    if (
      provider !== "openai" &&
      provider !== "anthropic" &&
      provider !== "ollama"
    ) {
      return c.json(
        { error: "provider は openai / anthropic / ollama のいずれかを指定してください" },
        400,
      );
    }
    const prompt = (body.prompt ?? "").trim();
    if (!prompt) {
      return c.json({ error: "プロンプトを入力してください" }, 400);
    }

    const now = new Date().toISOString();
    const session: MultiAISession = {
      id: randomUUID(),
      provider,
      title:
        (body.title ?? "").trim() ||
        prompt.replace(/\s+/g, " ").slice(0, 28) ||
        `${provider} セッション`,
      model: body.model?.trim() || null,
      status: "running",
      workspaceDir: body.workspaceDir?.trim() || undefined,
      sourceChatId: body.sourceChatId?.trim() || undefined,
      sourceChatTitle: body.sourceChatTitle?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          content: prompt,
          createdAt: now,
        },
      ],
    };

    sessionsMap.set(session.id, session);
    void persistSessions();

    // Run turn asynchronously so client gets immediate session ID
    void (async () => {
      try {
        const reply = await executeProviderTurn(session);
        session.messages.push({
          id: randomUUID(),
          role: "assistant",
          content: reply,
          createdAt: new Date().toISOString(),
        });
        session.status = "idle";
      } catch (err) {
        session.messages.push({
          id: randomUUID(),
          role: "assistant",
          content: `エラー: ${err instanceof Error ? err.message : String(err)}`,
          createdAt: new Date().toISOString(),
          error: true,
        });
        session.status = "error";
      } finally {
        session.updatedAt = new Date().toISOString();
        await persistSessions();
      }
    })();

    return c.json({ ok: true, session }, 201);
  });

  app.post("/api/providers/sessions/:id/messages", async (c) => {
    await ensureSessionsLoaded();
    const session = sessionsMap.get(c.req.param("id"));
    if (!session) {
      return c.json({ error: "セッションが見つかりません" }, 404);
    }
    if (session.status === "running") {
      return c.json({ error: "現在応答を生成中です。少しお待ちください。" }, 409);
    }

    let body: { prompt?: string; model?: string | null };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const prompt = (body.prompt ?? "").trim();
    if (!prompt) {
      return c.json({ error: "メッセージを入力してください" }, 400);
    }
    if (body.model !== undefined) {
      session.model = body.model?.trim() || null;
    }

    const now = new Date().toISOString();
    session.messages.push({
      id: randomUUID(),
      role: "user",
      content: prompt,
      createdAt: now,
    });
    session.status = "running";
    session.updatedAt = now;
    void persistSessions();

    void (async () => {
      try {
        const reply = await executeProviderTurn(session);
        session.messages.push({
          id: randomUUID(),
          role: "assistant",
          content: reply,
          createdAt: new Date().toISOString(),
        });
        session.status = "idle";
      } catch (err) {
        session.messages.push({
          id: randomUUID(),
          role: "assistant",
          content: `エラー: ${err instanceof Error ? err.message : String(err)}`,
          createdAt: new Date().toISOString(),
          error: true,
        });
        session.status = "error";
      } finally {
        session.updatedAt = new Date().toISOString();
        await persistSessions();
      }
    })();

    return c.json({ ok: true, session });
  });

  app.delete("/api/providers/sessions/:id", async (c) => {
    await ensureSessionsLoaded();
    const id = c.req.param("id");
    sessionsMap.delete(id);
    await persistSessions();
    return c.json({ ok: true, id });
  });
}
