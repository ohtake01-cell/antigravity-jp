/**
 * /api/models & /api/models/catalog routes
 *
 * 1. GET /api/models:
 *    Queries all running Antigravity Language Server instances in parallel and
 *    merges `clientModelConfigs` so newly added models on any LS version appear
 *    automatically without being masked by older LS instances.
 *
 * 2. GET /api/models/catalog:
 *    Auto-discovers active & available models across all 3 AI providers
 *    (Google/Antigravity, OpenAI/Codex, Anthropic/Claude) with zero hardcoded
 *    model lists — reading live LS RPCs, OpenAI/Anthropic `/v1/models` APIs
 *    (when API keys are present), Codex CLI's live-synced `models_cache.json`
 *    + `config.toml`, and Claude Code's recent session metadata.
 */

import type { Hono } from "hono";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  discovery,
  extractTargetAppDataDir,
  rpc,
  rpcAny,
} from "../routing.js";
import { handleRPCError } from "../errors.js";

export interface DiscoveredProviderModel {
  id: string;
  label: string;
  description?: string;
  isNew?: boolean;
  selectableInChat?: boolean;
  source: string;
}

export interface ProviderModelGroup {
  provider: "google" | "openai" | "anthropic";
  displayName: string;
  activeModelId: string | null;
  activeModelLabel: string | null;
  syncedAt: string | null;
  models: DiscoveredProviderModel[];
}

export interface ModelCatalogResponse {
  updatedAt: string;
  providers: {
    google: ProviderModelGroup;
    openai: ProviderModelGroup;
    anthropic: ProviderModelGroup;
  };
}

interface RawLSModelConfig {
  label?: string;
  modelOrAlias?: { model?: string };
  supportsImages?: boolean;
  isRecommended?: boolean;
  tagTitle?: string;
  tagDescription?: string;
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
  };
  [key: string]: unknown;
}

interface RawLSModelsPayload {
  clientModelConfigs?: RawLSModelConfig[];
  defaultOverrideModelConfig?: { modelOrAlias?: { model?: string } };
  [key: string]: unknown;
}

const CATALOG_TTL_MS = 30_000;
const MODELS_TTL_MS = process.env.VITEST ? 0 : 10_000;
let cachedCatalog: ModelCatalogResponse | null = null;
let cachedCatalogAt = 0;
let catalogInflight: Promise<ModelCatalogResponse> | null = null;

const mergedModelsCache = new Map<
  string,
  { fetchedAt: number; payload: RawLSModelsPayload }
>();
const mergedModelsInflight = new Map<string, Promise<RawLSModelsPayload>>();

export function inferModelFamily(
  id: string,
  label: string,
): "google" | "openai" | "anthropic" {
  const s = `${id} ${label}`.toLowerCase();
  if (s.includes("claude") || s.includes("anthropic")) return "anthropic";
  if (
    s.includes("gpt") ||
    s.includes("openai") ||
    s.includes("codex") ||
    /\bo[1345]\b/.test(s)
  ) {
    return "openai";
  }
  return "google";
}

function formatClaudeSlugLabel(slug: string): string {
  // e.g. "claude-fable-5-2" -> "Claude Fable 5.2", "claude-opus-5-5-20261001" -> "Claude Opus 5.5"
  const withoutDate = slug.replace(/-\d{8}$/, "");
  const m = withoutDate.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/i);
  if (m) {
    const tier = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    const ver = m[3] ? `${m[2]}.${m[3]}` : m[2];
    return `Claude ${tier} ${ver}`;
  }
  return withoutDate;
}

function formatOpenAISlugLabel(slug: string): string {
  // e.g. "gpt-6.2-astra" -> "GPT-6.2-Astra"
  return slug
    .split("-")
    .map((part) => {
      if (/^gpt$/i.test(part)) return "GPT";
      if (/^oss$/i.test(part)) return "OSS";
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("-");
}

export async function fetchMergedLSModels(
  targetApp?: string,
  forceRefresh = false,
): Promise<RawLSModelsPayload> {
  const cacheKey = targetApp ?? "__all__";
  if (!forceRefresh && MODELS_TTL_MS > 0) {
    const cached = mergedModelsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < MODELS_TTL_MS) {
      return cached.payload;
    }
    const inflight = mergedModelsInflight.get(cacheKey);
    if (inflight) {
      return await inflight;
    }
  }

  const run = (async (): Promise<RawLSModelsPayload> => {
  const instances = await discovery.getInstances(false, targetApp);
  if (instances.length === 0) {
    return (await rpcAny(
      "GetCascadeModelConfigData",
      {},
      targetApp,
    )) as RawLSModelsPayload;
  }

  const settled = await Promise.allSettled(
    instances.map((inst) =>
      rpc.call<RawLSModelsPayload>("GetCascadeModelConfigData", {}, inst),
    ),
  );

  const succeeded = settled
    .filter(
      (r): r is PromiseFulfilledResult<RawLSModelsPayload> =>
        r.status === "fulfilled" && !!r.value,
    )
    .map((r) => r.value);

  if (succeeded.length === 0) {
    return (await rpcAny(
      "GetCascadeModelConfigData",
      {},
      targetApp,
    )) as RawLSModelsPayload;
  }

  // Merge across all running LS instances so new models from newer LS builds
  // automatically appear even if an older LS instance is also running.
  const mergedMap = new Map<string, RawLSModelConfig>();
  let basePayload: RawLSModelsPayload = succeeded[0];

  for (const payload of succeeded) {
    if (
      (payload.clientModelConfigs?.length ?? 0) >
      (basePayload.clientModelConfigs?.length ?? 0)
    ) {
      basePayload = payload;
    }
    for (const cfg of payload.clientModelConfigs ?? []) {
      const modelId = cfg?.modelOrAlias?.model;
      if (!modelId) continue;
      const existing = mergedMap.get(modelId);
      if (
        !existing ||
        (cfg.quotaInfo?.remainingFraction !== undefined &&
          existing.quotaInfo?.remainingFraction === undefined)
      ) {
        mergedMap.set(modelId, cfg);
      }
    }
  }

  return {
    ...basePayload,
    clientModelConfigs: [...mergedMap.values()],
  };
  })();

  if (MODELS_TTL_MS > 0) {
    mergedModelsInflight.set(cacheKey, run);
  }
  try {
    const result = await run;
    if (MODELS_TTL_MS > 0) {
      mergedModelsCache.set(cacheKey, { fetchedAt: Date.now(), payload: result });
    }
    return result;
  } finally {
    if (mergedModelsInflight.get(cacheKey) === run) {
      mergedModelsInflight.delete(cacheKey);
    }
  }
}

async function discoverOpenAIModels(homeDir: string): Promise<{
  activeModelId: string | null;
  activeEffort: string | null;
  syncedAt: string | null;
  models: DiscoveredProviderModel[];
}> {
  const byId = new Map<string, DiscoveredProviderModel>();
  let syncedAt: string | null = null;
  let activeModelId: string | null = null;
  let activeEffort: string | null = null;

  // 1. Read Codex CLI config.toml for active model & effort
  try {
    const rawToml = await readFile(
      join(homeDir, ".codex", "config.toml"),
      "utf-8",
    );
    const modelMatch = rawToml.match(/^\s*model\s*=\s*"([^"]+)"/m);
    const effortMatch = rawToml.match(
      /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m,
    );
    if (modelMatch?.[1]) activeModelId = modelMatch[1].trim();
    if (effortMatch?.[1]) activeEffort = effortMatch[1].trim();
  } catch {
    // Codex config optional
  }

  // 2. Read Codex CLI auto-synced models_cache.json (kept fresh from OpenAI servers)
  try {
    const rawCache = await readFile(
      join(homeDir, ".codex", "models_cache.json"),
      "utf-8",
    );
    const parsed = JSON.parse(rawCache) as {
      fetched_at?: string;
      models?: Array<{
        slug?: string;
        display_name?: string;
        description?: string;
        visibility?: string;
        priority?: number;
      }>;
    };
    if (typeof parsed.fetched_at === "string") {
      syncedAt = parsed.fetched_at;
    }
    const visibleModels = (parsed.models ?? [])
      .filter((m) => m.slug && m.visibility !== "hide")
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

    visibleModels.forEach((m, index) => {
      const id = m.slug!;
      byId.set(id, {
        id,
        label: m.display_name || formatOpenAISlugLabel(id),
        description: m.description,
        isNew: index < 2,
        selectableInChat: false,
        source: "codex-cache",
      });
    });
  } catch {
    // Codex cache optional
  }

  // 3. Also query live OpenAI /v1/models API when OPENAI_API_KEY is available
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (apiKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = (await res.json()) as {
          data?: Array<{ id?: string; created?: number }>;
        };
        const chatModels = (json.data ?? [])
          .filter((m) => {
            const id = (m.id ?? "").toLowerCase();
            if (!id) return false;
            if (
              id.includes("embedding") ||
              id.includes("whisper") ||
              id.includes("tts") ||
              id.includes("moderation") ||
              id.includes("dall-e") ||
              id.includes("image") ||
              id.includes("realtime") ||
              id.includes("audio") ||
              id.includes("transcribe") ||
              id.includes("babbage") ||
              id.includes("davinci")
            ) {
              return false;
            }
            return (
              id.startsWith("gpt-") ||
              id.startsWith("codex") ||
              /^o[1345](-|$)/.test(id)
            );
          })
          .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));

        syncedAt = new Date().toISOString();
        for (const m of chatModels.slice(0, 20)) {
          const id = m.id!;
          if (!byId.has(id)) {
            byId.set(id, {
              id,
              label: formatOpenAISlugLabel(id),
              selectableInChat: false,
              source: "openai-api",
            });
          }
        }
      }
    } catch {
      // Non-fatal network error
    }
  }

  return {
    activeModelId,
    activeEffort,
    syncedAt,
    models: [...byId.values()],
  };
}

async function readTailUtf8(filePath: string, maxBytes = 65_536): Promise<string> {
  const fh = await open(filePath, "r");
  try {
    const st = await fh.stat();
    if (st.size === 0) return "";
    const readLen = Math.min(st.size, maxBytes);
    const offset = st.size - readLen;
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await fh.read(buf, 0, readLen, offset);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await fh.close();
  }
}

async function discoverAnthropicModels(homeDir: string): Promise<{
  activeModelId: string | null;
  syncedAt: string | null;
  models: DiscoveredProviderModel[];
}> {
  const byId = new Map<string, DiscoveredProviderModel>();
  let activeModelId: string | null = null;
  let syncedAt: string | null = null;

  // 1. Check ~/.claude/settings.json if default model is explicitly configured
  try {
    const rawSettings = await readFile(
      join(homeDir, ".claude", "settings.json"),
      "utf-8",
    );
    const parsed = JSON.parse(rawSettings) as { model?: string };
    if (typeof parsed.model === "string" && parsed.model.trim()) {
      activeModelId = parsed.model.trim();
    }
  } catch {
    // Optional
  }

  // 2. Scan recent Claude Code session jsonl tails for live model IDs
  try {
    const projectsRoot = join(homeDir, ".claude", "projects");
    const subdirs = await readdir(projectsRoot, { withFileTypes: true });
    const candidates: Array<{ path: string; mtimeMs: number }> = [];

    await Promise.all(
      subdirs
        .filter((d) => d.isDirectory())
        .map(async (dirEntry) => {
          const dirPath = join(projectsRoot, dirEntry.name);
          try {
            const files = await readdir(dirPath);
            for (const f of files) {
              if (!f.endsWith(".jsonl")) continue;
              const full = join(dirPath, f);
              try {
                const st = await stat(full);
                candidates.push({ path: full, mtimeMs: st.mtimeMs });
              } catch {
                // ignore
              }
            }
          } catch {
            // ignore
          }
        }),
    );

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (candidates[0]) {
      syncedAt = new Date(candidates[0].mtimeMs).toISOString();
    }

    for (const item of candidates.slice(0, 15)) {
      try {
        const tail = await readTailUtf8(item.path);
        const lines = tail.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          if (!line || !line.includes('"model"')) continue;
          try {
            const parsed = JSON.parse(line) as {
              model?: string;
              message?: { model?: string };
            };
            const m = parsed.message?.model ?? parsed.model;
            if (typeof m === "string" && m && !m.startsWith("<")) {
              if (!activeModelId) activeModelId = m;
              if (!byId.has(m)) {
                byId.set(m, {
                  id: m,
                  label: formatClaudeSlugLabel(m),
                  selectableInChat: false,
                  source: "claude-code",
                });
              }
            }
          } catch {
            // skip partial first line of tail slice
          }
        }
      } catch {
        // skip unreadable file
      }
    }
  } catch {
    // ~/.claude/projects optional
  }

  // 3. Also query live Anthropic /v1/models API when ANTHROPIC_API_KEY is available
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = (await res.json()) as {
          data?: Array<{ id?: string; display_name?: string }>;
        };
        syncedAt = new Date().toISOString();
        for (const m of json.data ?? []) {
          if (!m.id) continue;
          if (!byId.has(m.id)) {
            byId.set(m.id, {
              id: m.id,
              label: m.display_name || formatClaudeSlugLabel(m.id),
              selectableInChat: false,
              source: "anthropic-api",
            });
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return {
    activeModelId,
    syncedAt,
    models: [...byId.values()],
  };
}

export async function collectModelCatalog(options?: {
  homeDir?: string;
  targetApp?: string;
}): Promise<ModelCatalogResponse> {
  const home = options?.homeDir ?? homedir();
  const nowIso = new Date().toISOString();

  const [lsPayload, openaiInfo, anthropicInfo] = await Promise.all([
    fetchMergedLSModels(options?.targetApp).catch(
      (): RawLSModelsPayload => ({ clientModelConfigs: [] }),
    ),
    discoverOpenAIModels(home),
    discoverAnthropicModels(home),
  ]);

  const lsConfigs = lsPayload.clientModelConfigs ?? [];
  const lsDefaultId =
    lsPayload.defaultOverrideModelConfig?.modelOrAlias?.model ??
    lsConfigs[0]?.modelOrAlias?.model ??
    null;

  const googleModels: DiscoveredProviderModel[] = [];
  const lsOpenAIModels: DiscoveredProviderModel[] = [];
  const lsAnthropicModels: DiscoveredProviderModel[] = [];

  for (const cfg of lsConfigs) {
    const id = cfg.modelOrAlias?.model;
    const label = cfg.label;
    if (!id || !label) continue;
    const family = inferModelFamily(id, label);
    const entry: DiscoveredProviderModel = {
      id,
      label,
      description: cfg.tagDescription,
      isNew: cfg.tagTitle?.toLowerCase() === "new",
      selectableInChat: true,
      source: "antigravity-ls",
    };
    if (family === "openai") {
      lsOpenAIModels.push(entry);
    } else if (family === "anthropic") {
      lsAnthropicModels.push(entry);
    } else {
      googleModels.push(entry);
    }
  }

  // Merge OpenAI models (Codex/OpenAI API first, plus any LS-selectable OpenAI models)
  const openaiMergedMap = new Map<string, DiscoveredProviderModel>();
  for (const m of openaiInfo.models) {
    openaiMergedMap.set(m.id, m);
  }
  for (const m of lsOpenAIModels) {
    openaiMergedMap.set(m.id, m);
  }
  const openaiModels = [...openaiMergedMap.values()];
  const activeOpenAIObj = openaiInfo.activeModelId
    ? openaiMergedMap.get(openaiInfo.activeModelId)
    : openaiModels[0];
  const activeOpenAILabel = activeOpenAIObj
    ? openaiInfo.activeEffort
      ? `${activeOpenAIObj.label} (${openaiInfo.activeEffort})`
      : activeOpenAIObj.label
    : openaiInfo.activeModelId
      ? openaiInfo.activeEffort
        ? `${formatOpenAISlugLabel(openaiInfo.activeModelId)} (${openaiInfo.activeEffort})`
        : formatOpenAISlugLabel(openaiInfo.activeModelId)
      : null;

  // Merge Anthropic models (Claude Code / API + Antigravity-selectable Claude models)
  const anthropicMergedMap = new Map<string, DiscoveredProviderModel>();
  for (const m of anthropicInfo.models) {
    anthropicMergedMap.set(m.id, m);
  }
  for (const m of lsAnthropicModels) {
    anthropicMergedMap.set(m.id, m);
  }
  const anthropicModels = [...anthropicMergedMap.values()];
  const activeAnthropicObj = anthropicInfo.activeModelId
    ? anthropicMergedMap.get(anthropicInfo.activeModelId)
    : anthropicModels[0];
  const activeAnthropicLabel = activeAnthropicObj
    ? activeAnthropicObj.label
    : anthropicInfo.activeModelId
      ? formatClaudeSlugLabel(anthropicInfo.activeModelId)
      : null;

  const activeGoogleObj =
    lsConfigs.find((c) => c.modelOrAlias?.model === lsDefaultId) ??
    lsConfigs[0];

  return {
    updatedAt: nowIso,
    providers: {
      google: {
        provider: "google",
        displayName: "Google Gemini / Antigravity",
        activeModelId: lsDefaultId,
        activeModelLabel: activeGoogleObj?.label ?? null,
        syncedAt: lsConfigs.length > 0 ? nowIso : null,
        models: googleModels,
      },
      openai: {
        provider: "openai",
        displayName: "OpenAI / Codex",
        activeModelId:
          openaiInfo.activeModelId ?? openaiModels[0]?.id ?? null,
        activeModelLabel: activeOpenAILabel,
        syncedAt:
          openaiInfo.syncedAt ?? (openaiModels.length > 0 ? nowIso : null),
        models: openaiModels,
      },
      anthropic: {
        provider: "anthropic",
        displayName: "Anthropic / Claude",
        activeModelId:
          anthropicInfo.activeModelId ?? anthropicModels[0]?.id ?? null,
        activeModelLabel: activeAnthropicLabel,
        syncedAt:
          anthropicInfo.syncedAt ??
          (anthropicModels.length > 0 ? nowIso : null),
        models: anthropicModels,
      },
    },
  };
}

export function registerModelRoutes(app: Hono): void {
  app.get("/api/models", async (c) => {
    try {
      const targetApp = extractTargetAppDataDir(c);
      const force = c.req.query("refresh") === "1";
      const data = await fetchMergedLSModels(targetApp, force);
      return c.json(data);
    } catch (err) {
      return handleRPCError(c, err);
    }
  });

  app.get("/api/models/catalog", async (c) => {
    try {
      const force = c.req.query("refresh") === "1";
      const targetApp = extractTargetAppDataDir(c);
      const now = Date.now();
      if (
        !force &&
        !targetApp &&
        cachedCatalog &&
        now - cachedCatalogAt < CATALOG_TTL_MS
      ) {
        return c.json(cachedCatalog);
      }
      if (!force && !targetApp && catalogInflight) {
        return c.json(await catalogInflight);
      }
      const run = collectModelCatalog({ targetApp });
      if (!targetApp) {
        catalogInflight = run;
      }
      try {
        const catalog = await run;
        if (!targetApp) {
          cachedCatalog = catalog;
          cachedCatalogAt = Date.now();
        }
        return c.json(catalog);
      } finally {
        if (catalogInflight === run) {
          catalogInflight = null;
        }
      }
    } catch (err) {
      return handleRPCError(c, err);
    }
  });
}
