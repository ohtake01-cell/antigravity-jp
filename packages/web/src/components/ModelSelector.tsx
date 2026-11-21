import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { api } from "../api/client";
import type { DiscoveredProviderModel } from "../types";
import { IconCamera } from "./Icons";

interface ModelConfig {
  label: string;
  modelOrAlias: { model: string };
  supportsImages: boolean;
  isRecommended: boolean;
  tagTitle?: string;
  quotaInfo?: { remainingFraction: number };
}

interface Props {
  selectedModel: string | null;
  onSelect: (model: string) => void;
  onAutoHeal?: (model: string) => void;
}

function classifyProvider(label: string, id: string): "google" | "anthropic" | "openai" {
  const s = `${label} ${id}`.toLowerCase();
  if (s.includes("claude") || s.includes("anthropic")) return "anthropic";
  if (s.includes("gpt") || s.includes("openai") || s.includes("codex")) return "openai";
  return "google";
}

const PROVIDER_HEADERS: Record<"google" | "anthropic" | "openai", string> = {
  google: "Google Gemini",
  anthropic: "Anthropic Claude",
  openai: "OpenAI",
};

type ModelTier = "Low" | "Medium" | "High" | "XHigh";
const TIER_ORDER: readonly ModelTier[] = ["Low", "Medium", "High", "XHigh"];
const TIER_LABELS: Record<string, ModelTier> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
};

export function splitModelTier(label: string): {
  base: string;
  tier: ModelTier | null;
} {
  const match = label.match(/^(.*?)\s*\((Low|Medium|High|XHigh)\)$/i);
  if (!match) {
    return { base: label, tier: null };
  }
  const normalizedTier = TIER_LABELS[match[2].toLowerCase()] ?? null;
  if (!normalizedTier) {
    return { base: label, tier: null };
  }
  return { base: match[1].trim(), tier: normalizedTier };
}

/**
 * Compact model base name for narrow mobile chat input bars so
 * "Gemini 4 Neon" shows "Neon" instead of truncating to "Gemini 4...".
 */
export function formatMobileSelectorBase(base: string): string {
  const trimmed = base.trim();
  const orch = /^Orchestrator\s*\(([^)]+)\)$/i.exec(trimmed);
  if (orch) return `Orch · ${orch[1].trim()}`;
  const g4 = /^Gemini\s+4(?:\.\d+)?\s+([A-Za-z0-9.+-]+)$/i.exec(trimmed);
  if (g4) return g4[1].trim();
  const gf = /^Gemini\s+([\d.]+)\s+Flash$/i.exec(trimmed);
  if (gf) return `Flash ${gf[1]}`;
  const claude = /^Claude\s+(Opus|Sonnet|Haiku)(?:\s+([\d.]+))?$/i.exec(trimmed);
  if (claude) return claude[2] ? `${claude[1]} ${claude[2]}` : claude[1];
  return trimmed;
}

type ModelGroupEntry =
  | {
      kind: "family";
      base: string;
      variants: Array<{ model: ModelConfig; tier: ModelTier }>;
    }
  | {
      kind: "single";
      model: ModelConfig;
    };

function buildGroupEntries(items: ModelConfig[]): ModelGroupEntry[] {
  const buckets = new Map<string, Array<{ model: ModelConfig; tier: ModelTier }>>();
  const orderedTokens: Array<
    | { type: "family"; base: string }
    | { type: "single"; model: ModelConfig }
  > = [];

  for (const m of items) {
    const parts = splitModelTier(m.label);
    if (parts.tier) {
      let list = buckets.get(parts.base);
      if (!list) {
        list = [];
        buckets.set(parts.base, list);
        orderedTokens.push({ type: "family", base: parts.base });
      }
      list.push({ model: m, tier: parts.tier });
    } else {
      orderedTokens.push({ type: "single", model: m });
    }
  }

  return orderedTokens.map((tok) => {
    if (tok.type === "single") {
      return { kind: "single", model: tok.model };
    }
    const list = buckets.get(tok.base)!;
    if (list.length < 2) {
      return { kind: "single", model: list[0].model };
    }
    const sorted = [...list].sort(
      (a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier),
    );
    return { kind: "family", base: tok.base, variants: sorted };
  });
}

export function ModelSelector({ selectedModel, onSelect, onAutoHeal }: Props) {
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [externalOpenAIModels, setExternalOpenAIModels] = useState<DiscoveredProviderModel[]>([]);
  const [activeOpenAIId, setActiveOpenAIId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const lastFetchedAtRef = useRef<number>(0);
  const ref = useRef<HTMLDivElement>(null);

  const fetchModels = useCallback(async (retries = 3, forceCatalog = false) => {
    setRefreshing(true);
    try {
      for (let i = 0; i < retries; i++) {
        try {
          const [data, catalog] = await Promise.all([
            api.models(),
            Promise.resolve(api.modelCatalog?.(forceCatalog)).catch(() => null),
          ]);
          const configs = data.clientModelConfigs ?? [];
          const liveDefault =
            data.defaultOverrideModelConfig?.modelOrAlias?.model ??
            configs[0]?.modelOrAlias?.model ??
            null;
          setModels(configs);
          setDefaultModel(liveDefault);
          if (catalog?.providers?.openai) {
            setExternalOpenAIModels(
              catalog.providers.openai.models.filter((m) => !m.selectableInChat),
            );
            setActiveOpenAIId(catalog.providers.openai.activeModelId);
          }
          lastFetchedAtRef.current = Date.now();
          setFetchError(false);
          return;
        } catch {
          if (i < retries - 1) {
            await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
          }
        }
      }
      setFetchError(true);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Initial load + periodic background auto-sync + window focus refresh
  useEffect(() => {
    void fetchModels();
    const intervalId = window.setInterval(() => {
      void fetchModels(1, false);
    }, 180_000);
    const onFocus = () => {
      if (Date.now() - lastFetchedAtRef.current > 30_000) {
        void fetchModels(1, false);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchModels]);

  // Auto-heal stale/retired or missing model IDs saved in localStorage
  useEffect(() => {
    if (models.length === 0 || !defaultModel) return;
    const isValid =
      selectedModel !== null &&
      models.some((m) => m.modelOrAlias.model === selectedModel);
    if (!isValid) {
      onSelect(defaultModel);
      onAutoHeal?.(defaultModel);
    }
  }, [models, defaultModel, selectedModel, onSelect, onAutoHeal]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

function renderNewBadge() {
  return (
    <span
      style={{
        marginLeft: "5px",
        fontSize: "9.5px",
        padding: "0 4px",
        borderRadius: "4px",
        background: "var(--tone-green-bg, rgba(52, 211, 153, 0.16))",
        color: "var(--tone-green-fg, #34d399)",
        fontWeight: 700,
      }}
    >
      NEW
    </span>
  );
}

function renderModelMeta(m: ModelConfig) {
  const quota = m.quotaInfo?.remainingFraction;
  return (
    <span className="model-option-meta">
      {m.supportsImages && (
        <>
          <IconCamera size={12} />{" "}
        </>
      )}
      {typeof quota === "number" && (
        <span
          className="model-quota"
          style={{
            color:
              quota <= 0.2
                ? "var(--status-error, #ef5350)"
                : quota <= 0.5
                  ? "#f59e0b"
                  : "#60a5fa",
            fontWeight: 600,
          }}
        >
          {Math.round(quota * 100)}%
        </span>
      )}
    </span>
  );
}

  const groupedModels = useMemo(() => {
    const groups: Array<{
      provider: "google" | "anthropic" | "openai";
      items: ModelConfig[];
    }> = [
      { provider: "google", items: [] },
      { provider: "anthropic", items: [] },
      { provider: "openai", items: [] },
    ];
    for (const m of models) {
      const p = classifyProvider(m.label, m.modelOrAlias.model);
      const bucket = groups.find((g) => g.provider === p);
      bucket?.items.push(m);
    }
    return groups
      .filter((g) => g.items.length > 0)
      .map((g) => ({
        provider: g.provider,
        entries: buildGroupEntries(g.items),
      }));
  }, [models]);

  const active = selectedModel ?? defaultModel;
  const activeModelObj =
    models.find((m) => m.modelOrAlias.model === active) ??
    (defaultModel
      ? models.find((m) => m.modelOrAlias.model === defaultModel)
      : undefined) ??
    models[0];
  const effectiveActiveId = activeModelObj?.modelOrAlias.model ?? active;
  const activeLabel = activeModelObj?.label ?? "モデル読込中…";
  const activeParts = splitModelTier(activeLabel);
  const activeQuota = activeModelObj?.quotaInfo?.remainingFraction;

  return (
    <div className="model-selector" ref={ref}>
      <button
        type="button"
        className="model-selector-btn"
        onClick={() => {
          const next = !open;
          if (
            next &&
            (fetchError ||
              models.length === 0 ||
              Date.now() - lastFetchedAtRef.current > 15_000)
          ) {
            void fetchModels(1, false);
          }
          setOpen(next);
        }}
        title="モデルを選択（新モデル自動同期）"
      >
        <span className="model-selector-label">
          {activeParts.tier ? (
            <>
              <span className="model-selector-base model-selector-base-full">
                {activeParts.base}
              </span>
              <span
                className="model-selector-base model-selector-base-short"
                aria-hidden="true"
              >
                {formatMobileSelectorBase(activeParts.base)}
              </span>{" "}
              <span className="model-selector-tier-pill">
                ({activeParts.tier})
              </span>
            </>
          ) : (
            <>
              <span className="model-selector-base model-selector-base-full">
                {activeLabel}
              </span>
              <span
                className="model-selector-base model-selector-base-short"
                aria-hidden="true"
              >
                {formatMobileSelectorBase(activeLabel)}
              </span>
            </>
          )}
        </span>
        {typeof activeQuota === "number" && (
          <span
            className="model-selector-quota-pill"
            style={{
              fontSize: "10px",
              padding: "1px 5px",
              borderRadius: "999px",
              background:
                activeQuota <= 0.2
                  ? "var(--tone-red-bg, rgba(239, 83, 80, 0.2))"
                  : "var(--quota-pill-bg, rgba(255, 255, 255, 0.08))",
              color:
                activeQuota <= 0.2
                  ? "var(--tone-red-fg, #ef5350)"
                  : "var(--tone-blue-fg, #93c5fd)",
              fontWeight: 600,
              marginLeft: "4px",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            {Math.round(activeQuota * 100)}%
          </span>
        )}
        <span className="model-selector-caret">▾</span>
      </button>
      {open && (
        <div className="model-selector-dropdown">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "4px 10px 6px",
              borderBottom: "1px solid rgba(255,255,255,0.07)",
              fontSize: "10.5px",
              color: "var(--text-tertiary, #94a3b8)",
            }}
          >
            <span>AIモデル（自動取得）</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void fetchModels(1, true);
              }}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-secondary, #cbd5e1)",
                fontSize: "11px",
                cursor: "pointer",
                padding: "1px 5px",
              }}
              title="最新モデル一覧を再取得"
            >
              {refreshing ? "同期中…" : "↻ 最新取得"}
            </button>
          </div>

          {fetchError && (
            <button
              className="model-option"
              onClick={() => void fetchModels(2, true)}
              style={{
                color: "var(--text-tertiary)",
                justifyContent: "center",
              }}
            >
              ⟳ モデル一覧を再読み込み
            </button>
          )}

          {groupedModels.map((group) => (
            <div key={group.provider}>
              <div
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  letterSpacing: "0.03em",
                  color: "var(--text-tertiary, #94a3b8)",
                  padding: "6px 10px 2px",
                }}
              >
                {PROVIDER_HEADERS[group.provider]}
              </div>
              {group.entries.map((entry) => {
                if (entry.kind === "family") {
                  const rep =
                    entry.variants.find(
                      (v) => v.model.modelOrAlias.model === effectiveActiveId,
                    )?.model ??
                    entry.variants.find(
                      (v) => v.model.quotaInfo?.remainingFraction !== undefined,
                    )?.model ??
                    entry.variants[0].model;
                  const anyNew = entry.variants.some(
                    (v) => v.model.tagTitle?.toLowerCase() === "new",
                  );
                  return (
                    <div key={entry.base} className="model-family-row">
                      <div className="model-family-header">
                        <span className="model-option-label">
                          {entry.base}
                          {anyNew && renderNewBadge()}
                        </span>
                        {renderModelMeta(rep)}
                      </div>
                      <div
                        className="model-tier-group"
                        role="group"
                        aria-label={`${entry.base} のティア`}
                      >
                        {entry.variants.map(({ model: v, tier }) => {
                          const isActive =
                            v.modelOrAlias.model === effectiveActiveId;
                          const vQuota = v.quotaInfo?.remainingFraction;
                          const quotaHint =
                            typeof vQuota === "number"
                              ? ` (${Math.round(vQuota * 100)}%)`
                              : "";
                          return (
                            <button
                              type="button"
                              key={v.modelOrAlias.model}
                              className={`model-tier-btn ${isActive ? "active" : ""}`}
                              aria-label={v.label}
                              aria-pressed={isActive}
                              title={`${v.label}${quotaHint}`}
                              onClick={() => {
                                onSelect(v.modelOrAlias.model);
                                setOpen(false);
                              }}
                            >
                              {tier}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                }

                const m = entry.model;
                const isActive = m.modelOrAlias.model === effectiveActiveId;
                const isNew = m.tagTitle?.toLowerCase() === "new";
                return (
                  <button
                    type="button"
                    key={m.modelOrAlias.model}
                    className={`model-option ${isActive ? "active" : ""}`}
                    onClick={() => {
                      onSelect(m.modelOrAlias.model);
                      setOpen(false);
                    }}
                  >
                    <span className="model-option-label">
                      {m.label}
                      {isNew && renderNewBadge()}
                    </span>
                    {renderModelMeta(m)}
                  </button>
                );
              })}
            </div>
          ))}

          {externalOpenAIModels.length > 0 && (
            <div
              style={{
                marginTop: "4px",
                paddingTop: "4px",
                borderTop: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <div
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  color: "#34d399",
                  padding: "4px 10px 2px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>OpenAI 最新モデル（Codex自動同期）</span>
                <span
                  style={{
                    fontWeight: 500,
                    color: "var(--text-tertiary, #94a3b8)",
                  }}
                >
                  Codex専用
                </span>
              </div>
              {externalOpenAIModels.slice(0, 6).map((om) => {
                const isCodexCurrent = om.id === activeOpenAIId;
                return (
                  <div
                    key={om.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "5px 10px",
                      fontSize: "12px",
                      color: "var(--text-secondary, #cbd5e1)",
                      opacity: 0.9,
                    }}
                    title={om.description || `${om.label} (Codex側で利用可能)`}
                  >
                    <span>
                      {om.label}
                      {om.isNew && (
                        <span
                          style={{
                            marginLeft: "5px",
                            fontSize: "9.5px",
                            padding: "0 4px",
                            borderRadius: "4px",
                            background: "rgba(52, 211, 153, 0.16)",
                            color: "#34d399",
                            fontWeight: 700,
                          }}
                        >
                          NEW
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        fontSize: "10px",
                        color: isCodexCurrent
                          ? "#34d399"
                          : "var(--text-tertiary, #94a3b8)",
                        fontWeight: isCodexCurrent ? 700 : 500,
                      }}
                    >
                      {isCodexCurrent ? "Codex使用中" : "Codex対応"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
