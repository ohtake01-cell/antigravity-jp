import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";

interface QuotaModelInfo {
  label: string;
  model: string;
  remainingFraction: number;
  resetTime?: string;
}

interface TokenQuotaBadgeProps {
  /** Renders the full model quota list inline (used inside mobile bottom sheet). */
  inlineDetails?: boolean;
}

export function TokenQuotaBadge({ inlineDetails = false }: TokenQuotaBadgeProps) {
  const [modelQuotas, setModelQuotas] = useState<QuotaModelInfo[]>([]);
  const [expanded, setExpanded] = useState(false);

  const fetchQuota = useCallback(async () => {
    try {
      const data = await api.models();
      const list: QuotaModelInfo[] = (data.clientModelConfigs ?? [])
        .filter((m) => m.quotaInfo && typeof m.quotaInfo.remainingFraction === "number")
        .map((m) => ({
          label: m.label,
          model: m.modelOrAlias.model,
          remainingFraction: m.quotaInfo!.remainingFraction,
          resetTime: m.quotaInfo!.resetTime,
        }));
      setModelQuotas(list);
    } catch {
      // Background poll silently fails
    }
  }, []);

  useEffect(() => {
    fetchQuota();
    const timer = setInterval(fetchQuota, 30000); // 30秒ごとに自動更新
    return () => clearInterval(timer);
  }, [fetchQuota]);

  if (modelQuotas.length === 0) {
    return (
      <div className="token-quota-container">
        <div
          className="token-quota-badge"
          style={{ opacity: 0.7, padding: "2px 7px" }}
          title="トークン残量を取得中..."
        >
          <span
            className="token-quota-dot"
            style={{ backgroundColor: "#60a5fa" }}
          />
          <span className="token-quota-pct">...</span>
        </div>
      </div>
    );
  }

  // 主力のモデル (先頭またはCarbon/Pro系)
  const primary = modelQuotas[0];
  const pct = Math.round(primary.remainingFraction * 100);

  // 状態カラーの計算 (Gemini風)
  const isLow = pct <= 20;
  const isWarn = pct <= 50 && pct > 20;
  const statusColor = isLow
    ? "var(--tone-red-fg, var(--status-error, #ef5350))"
    : isWarn
      ? "var(--tone-amber-fg, #f59e0b)"
      : "var(--tone-blue-fg, var(--c-gemini-sparkle, #4da3ff))";

  // リセット時刻のフォーマット (例: "15:31" または "残り 2時間")
  const formatReset = (iso?: string) => {
    if (!iso) return null;
    try {
      const d = new Date(iso);
      const diffMin = Math.round((d.getTime() - Date.now()) / 60000);
      if (diffMin <= 0) return "まもなくリセット";
      if (diffMin < 60) return `あと ${diffMin}分`;
      const hrs = Math.floor(diffMin / 60);
      const mins = diffMin % 60;
      return `あと ${hrs}時間${mins > 0 ? mins + "分" : ""}`;
    } catch {
      return null;
    }
  };

  if (inlineDetails) {
    return (
      <div className="token-quota-inline-list">
        {modelQuotas.map((m) => {
          const p = Math.round(m.remainingFraction * 100);
          const color =
            p <= 20
              ? "var(--tone-red-fg, #ef5350)"
              : p <= 50
                ? "var(--tone-amber-fg, #f59e0b)"
                : "var(--tone-blue-fg, #4da3ff)";
          const reset = formatReset(m.resetTime);
          return (
            <div key={m.model} className="token-quota-inline-row">
              <div className="token-quota-inline-top">
                <span className="token-quota-inline-name">{m.label}</span>
                <span className="token-quota-inline-pct" style={{ color }}>
                  {p}%
                </span>
              </div>
              <div className="token-quota-bar-track">
                <div
                  className="token-quota-bar-fill"
                  style={{ width: `${p}%`, backgroundColor: color }}
                />
              </div>
              {reset && (
                <div className="token-quota-item-reset">枠リセット: {reset}</div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="token-quota-container">
      <button
        className="token-quota-badge"
        onClick={() => setExpanded((v) => !v)}
        title="タップで全モデルのトークン・クォータ残量を確認"
        type="button"
      >
        <span
          className="token-quota-dot"
          style={{ backgroundColor: statusColor, boxShadow: `0 0 8px ${statusColor}` }}
        />
        <span className="token-quota-pct">{pct}%</span>
        <div className="token-quota-mini-bar">
          <div
            className="token-quota-mini-fill"
            style={{ width: `${pct}%`, backgroundColor: statusColor }}
          />
        </div>
        {formatReset(primary.resetTime) && (
          <span className="token-quota-time-label">
            {formatReset(primary.resetTime)}
          </span>
        )}
      </button>

      {expanded && (
        <div className="token-quota-popover">
          <div className="token-quota-popover-header">
            <span>⚡️ モデル利用枠 / トークン残量</span>
            <button
              className="token-quota-popover-close"
              onClick={() => setExpanded(false)}
            >
              ✕
            </button>
          </div>
          <div className="token-quota-popover-list">
            {modelQuotas.map((m) => {
              const p = Math.round(m.remainingFraction * 100);
              const color =
            p <= 20
              ? "var(--tone-red-fg, #ef5350)"
              : p <= 50
                ? "var(--tone-amber-fg, #f59e0b)"
                : "var(--tone-blue-fg, #4da3ff)";
              const reset = formatReset(m.resetTime);
              return (
                <div key={m.model} className="token-quota-popover-item">
                  <div className="token-quota-item-header">
                    <span className="token-quota-model-name">{m.label}</span>
                    <span className="token-quota-item-pct" style={{ color }}>
                      {p}%
                    </span>
                  </div>
                  <div className="token-quota-bar-track">
                    <div
                      className="token-quota-bar-fill"
                      style={{ width: `${p}%`, backgroundColor: color }}
                    />
                  </div>
                  {reset && (
                    <div className="token-quota-item-reset">
                      枠リセット: {reset}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
