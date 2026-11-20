import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api/client";
import type {
  AppTier,
  WeeklyUsageResponse,
  AgentWeeklyBucket,
  ModelCatalogResponse,
} from "../types";

export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(2)}B`;
  }
  if (n >= 100_000_000) {
    return `${Math.round(n / 1_000_000)}M`;
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${Math.round(n / 1_000)}K`;
  }
  return String(Math.round(n));
}

function formatResetShort(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}回復`;
}

interface QuotaDisplay {
  remainingPercent?: number | null;
  resetIso?: string | null;
  prefixLabel?: string;
  statusNote?: string | null;
}

function AgentRow({
  name,
  modelLabel,
  subModelsHint,
  bucket,
  accent,
  quotaOverride,
}: {
  name: string;
  modelLabel?: string | null;
  subModelsHint?: string | null;
  bucket: AgentWeeklyBucket;
  accent: string;
  quotaOverride?: QuotaDisplay;
}) {
  const wq = bucket.weekly_quota;
  const remPct =
    quotaOverride?.remainingPercent !== undefined
      ? quotaOverride.remainingPercent
      : typeof wq?.remaining_percent === "number"
        ? wq.remaining_percent
        : typeof wq?.used_percent === "number"
          ? Math.max(0, 100 - wq.used_percent)
          : null;
  const resetIso = quotaOverride?.resetIso ?? wq?.resets_at_iso;
  const prefix = quotaOverride?.prefixLabel ?? "週残り";
  const note = quotaOverride?.statusNote ?? wq?.status_note;

  const remColor =
    typeof remPct === "number"
      ? remPct <= 15
        ? "#ef5350"
        : remPct <= 40
          ? "#f59e0b"
          : "#34d399"
      : "#94a3b8";

  return (
    <div
      style={{
        padding: "7px 9px",
        borderRadius: "8px",
        background: "rgba(255, 255, 255, 0.035)",
        border: "1px solid rgba(255, 255, 255, 0.06)",
        display: "flex",
        flexDirection: "column",
        gap: "3px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: "6px",
            minWidth: 0,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: accent,
            }}
          >
            {name}
          </span>
          {modelLabel && (
            <span
              style={{
                fontSize: "10.5px",
                fontWeight: 500,
                color: "var(--text-secondary, #cbd5e1)",
                background: "rgba(255, 255, 255, 0.06)",
                padding: "0px 5px",
                borderRadius: "4px",
              }}
            >
              {modelLabel}
            </span>
          )}
        </div>
        <span
          style={{
            fontSize: "12.5px",
            fontWeight: 700,
            color: "var(--text-primary, #f1f5f9)",
            flexShrink: 0,
          }}
        >
          {formatCompactTokens(bucket.active_tokens)} tok
        </span>
      </div>
      {subModelsHint && (
        <div
          style={{
            fontSize: "10px",
            color: "var(--text-tertiary, #94a3b8)",
            lineHeight: 1.35,
          }}
        >
          {subModelsHint}
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          fontSize: "10.5px",
          color: "var(--text-tertiary, #94a3b8)",
          gap: "4px 6px",
        }}
      >
        <span>
          込 {formatCompactTokens(bucket.gross_tokens)} · {bucket.conversations}会話
        </span>
        {typeof remPct === "number" ? (
          <span style={{ color: remColor, fontWeight: 600 }}>
            {prefix} {Math.round(remPct)}%
            {resetIso ? ` (${formatResetShort(resetIso)})` : ""}
          </span>
        ) : note ? (
          <span style={{ color: "#f59e0b", fontWeight: 500 }}>{note}</span>
        ) : null}
      </div>
    </div>
  );
}

export function WeeklyUsageBadge({
  selectedModel,
  appTier = "lite",
}: {
  selectedModel?: string | null;
  appTier?: AppTier;
}) {
  const [data, setData] = useState<WeeklyUsageResponse | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogResponse | null>(null);
  const [gearModelLabel, setGearModelLabel] = useState<string | null>(null);
  const [gearQuota, setGearQuota] = useState<QuotaDisplay | undefined>(
    undefined,
  );
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const [weeklyRes, modelsRes, catalogRes] = await Promise.all([
          api.weeklyUsage(force).catch(() => null),
          api.models().catch(() => null),
          Promise.resolve(api.modelCatalog?.(force)).catch(() => null),
        ]);
        if (weeklyRes) {
          setData(weeklyRes);
        }
        if (catalogRes) {
          setCatalog(catalogRes);
        }
        if (modelsRes?.clientModelConfigs?.length) {
          const activeId =
            selectedModel ??
            modelsRes.defaultOverrideModelConfig?.modelOrAlias?.model;
          const exactMatch = modelsRes.clientModelConfigs.find(
            (m) => m.modelOrAlias.model === activeId,
          );
          const geminiMatch = modelsRes.clientModelConfigs.find(
            (m) =>
              m.label.toLowerCase().includes("gemini") &&
              typeof m.quotaInfo?.remainingFraction === "number",
          );
          const matched =
            (typeof exactMatch?.quotaInfo?.remainingFraction === "number"
              ? exactMatch
              : undefined) ??
            geminiMatch ??
            exactMatch ??
            modelsRes.clientModelConfigs[0];
          setGearModelLabel(matched?.label ?? null);
          if (typeof matched?.quotaInfo?.remainingFraction === "number") {
            setGearQuota({
              remainingPercent: matched.quotaInfo.remainingFraction * 100,
              resetIso: matched.quotaInfo.resetTime ?? null,
              prefixLabel: "残り",
            });
          } else {
            setGearQuota(undefined);
          }
        }
      } catch {
        // keep previous snapshot on transient error
      } finally {
        setLoading(false);
      }
    },
    [selectedModel],
  );

  useEffect(() => {
    void load(false);
    const id = window.setInterval(() => {
      void load(false);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [load]);

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

  const gearRemPct =
    typeof gearQuota?.remainingPercent === "number"
      ? Math.round(gearQuota.remainingPercent)
      : null;
  const gearActive = data?.gear.active_tokens ?? 0;
  const pillText =
    gearRemPct !== null
      ? `残 ${gearRemPct}%`
      : data
        ? `週 ${formatCompactTokens(gearActive)}`
        : "残 …";
  const pillColor =
    gearRemPct !== null
      ? gearRemPct <= 15
        ? "#ef5350"
        : gearRemPct <= 40
          ? "#f59e0b"
          : "#34d399"
      : undefined;
  const maxDay = Math.max(
    1,
    ...(data?.daily.map((d) => d.total_active) ?? [1]),
  );

  return (
    <div className="model-selector" ref={ref}>
      <button
        type="button"
        className="model-selector-btn"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load(false);
        }}
        title="Gemini公式枠の残り%と週間トークン消費を表示"
      >
        <span
          className="model-selector-label"
          style={pillColor ? { color: pillColor, fontWeight: 600 } : undefined}
        >
          {pillText}
        </span>
        <span className="model-selector-caret">▾</span>
      </button>

      {open && (
        <div
          className="model-selector-dropdown"
          style={{
            minWidth: "295px",
            maxWidth: "min(340px, 92vw)",
            padding: "10px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
              paddingBottom: "6px",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  color: "var(--text-primary, #f8fafc)",
                }}
              >
                週間トークン消費 ＆ 残り枠
              </span>
              {data && (
                <span
                  style={{
                    fontSize: "10px",
                    color: "var(--text-tertiary, #94a3b8)",
                  }}
                >
                  {data.window.start_date} 〜 {data.window.end_date} · 週間計{" "}
                  {formatCompactTokens(data.gear.active_tokens)}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void load(true)}
              style={{
                background: "rgba(255,255,255,0.07)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: "6px",
                color: "var(--text-secondary, #cbd5e1)",
                fontSize: "11px",
                padding: "2px 7px",
                cursor: "pointer",
              }}
              title="最新値を再集計"
            >
              {loading ? "…" : "↻"}
            </button>
          </div>

          {data ? (
            <>
              <AgentRow
                name="Antigravity (Gemini)"
                modelLabel={
                  gearModelLabel ?? catalog?.providers.google.activeModelLabel
                }
                bucket={data.gear}
                accent="#60a5fa"
                quotaOverride={gearQuota}
              />
              {appTier === "pro" && catalog?.providers.openai.activeModelLabel && (
                <AgentRow
                  name="OpenAI (Codex)"
                  modelLabel={catalog.providers.openai.activeModelLabel}
                  bucket={data.codex}
                  accent="#34d399"
                />
              )}
              {appTier === "pro" && catalog?.providers.anthropic.activeModelLabel && (
                <AgentRow
                  name="Anthropic (Claude)"
                  modelLabel={catalog.providers.anthropic.activeModelLabel}
                  bucket={data.code}
                  accent="#c084fc"
                />
              )}

              <div
                style={{
                  marginTop: "2px",
                  paddingTop: "6px",
                  borderTop: "1px solid rgba(255,255,255,0.07)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                }}
              >
                <span
                  style={{
                    fontSize: "10.5px",
                    color: "var(--text-tertiary, #94a3b8)",
                    fontWeight: 600,
                  }}
                >
                  日別推移（新規入出力トークン）
                </span>
                {data.daily.map((d) => {
                  const pct = Math.max(
                    2,
                    Math.round((d.total_active / maxDay) * 100),
                  );
                  return (
                    <div
                      key={d.date}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "62px 1fr 52px",
                        alignItems: "center",
                        gap: "6px",
                        fontSize: "10.5px",
                      }}
                    >
                      <span style={{ color: "var(--text-secondary, #cbd5e1)" }}>
                        {d.label}
                      </span>
                      <div
                        style={{
                          height: "6px",
                          borderRadius: "999px",
                          background: "rgba(255,255,255,0.07)",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${pct}%`,
                            height: "100%",
                            borderRadius: "999px",
                            background:
                              "linear-gradient(90deg, #60a5fa 0%, #34d399 100%)",
                          }}
                        />
                      </div>
                      <span
                        style={{
                          textAlign: "right",
                          color: "var(--text-tertiary, #94a3b8)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {formatCompactTokens(d.total_active)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div
              style={{
                fontSize: "11.5px",
                color: "var(--text-tertiary, #94a3b8)",
                padding: "8px 4px",
                textAlign: "center",
              }}
            >
              集計データを読み込み中…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
