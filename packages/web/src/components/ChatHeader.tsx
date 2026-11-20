import { useEffect, useState } from "react";
import { IconMenu, IconFolder, IconSpinner } from "./Icons";
import { AppTargetSelector } from "./AppTargetSelector";
import { TokenQuotaBadge } from "./TokenQuotaBadge";
import { formatCompactModelBadge, type CompactModelProvider } from "./Sidebar";
import type { TargetApp } from "../types";

interface Props {
  title: string;
  projectName?: string;
  modelLabel?: string;
  modelProvider?: CompactModelProvider;
  targetApp?: TargetApp;
  onTargetAppChange?: (app: TargetApp) => void;
  onMenuToggle?: () => void;
  isRunning?: boolean;
  mode?: "chat" | "command";
  onModeChange?: (mode: "chat" | "command") => void;
  workbenchOpen?: boolean;
  onToggleWorkbench?: () => void;
  agentPanelOpen?: boolean;
  onToggleAgentPanel?: () => void;
  agentCount?: number;
  hasRunningAgent?: boolean;
  onOpenPalette?: () => void;
  pendingApprovalsCount?: number;
  runningAICount?: number;
}

export function ChatHeader({
  title,
  projectName,
  modelLabel,
  modelProvider,
  targetApp,
  onTargetAppChange,
  onMenuToggle,
  isRunning,
  mode = "chat",
  onModeChange,
  workbenchOpen = false,
  onToggleWorkbench,
  agentPanelOpen = false,
  onToggleAgentPanel,
  agentCount = 0,
  hasRunningAgent = false,
  onOpenPalette,
  pendingApprovalsCount = 0,
  runningAICount = 0,
}: Props) {
  const headerBadge = formatCompactModelBadge(modelLabel, modelProvider);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);

  useEffect(() => {
    if (!mobileToolsOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileToolsOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileToolsOpen]);

  const targetAppOptions: ReadonlyArray<{ id: TargetApp; label: string }> = [
    { id: "all", label: "🌐 全エンジン" },
    { id: "antigravity", label: "🚀 Antigravity 2" },
    { id: "antigravity-ide", label: "⚡ IDE" },
  ];

  return (
    <div className="main-header">
      {onMenuToggle && (
        <button
          className="mobile-menu-btn"
          onClick={onMenuToggle}
          title="メニューを開く"
          aria-label="メニューを開く"
        >
          <IconMenu size={18} />
        </button>
      )}
      <span
        className={`main-header-title ${isRunning ? "running" : ""}`}
        onClick={() => {
          document
            .querySelector(".chat-area")
            ?.scrollTo({ top: 0, behavior: "smooth" });
        }}
      >
        {isRunning && (
          <span
            className="sidebar-running-spinner-wrap"
            style={{ marginRight: 6 }}
            title="現在操作中 (実行中)"
          >
            <IconSpinner
              size={14}
              className="sidebar-running-spinner active-chat"
            />
          </span>
        )}
        <span
          className={isRunning ? "sidebar-title-blinking active-chat" : ""}
        >
          {title}
        </span>
        {headerBadge && (
          <span
            className={`sidebar-model-badge header-model-badge provider-${headerBadge.provider}`}
            title={`使用モデル: ${headerBadge.fullLabel}`}
            data-testid="header-model-badge"
          >
            <span className="sidebar-model-dot" aria-hidden="true" />
            <span className="sidebar-model-badge-text">{headerBadge.text}</span>
          </span>
        )}
      </span>
      <div className="main-header-actions">
        {onOpenPalette && (
          <button
            type="button"
            className="header-palette-btn"
            onClick={onOpenPalette}
            title="クイックパレットを開く (⌘K)"
            aria-label="クイックパレットを開く"
          >
            <span className="header-palette-kbd">⌘K</span>
            <span className="header-palette-mobile-icon" aria-hidden="true">
              🔍
            </span>
          </button>
        )}
        {onToggleWorkbench && (
          <button
            type="button"
            className={`header-tool-btn header-desktop-only ${workbenchOpen ? "active" : ""}`}
            aria-pressed={workbenchOpen}
            onClick={onToggleWorkbench}
            title="右ペイン独立エディタ＆多形式ビューア (Markdown / CSV / PDF / Mermaid)"
          >
            📄 エディタ
          </button>
        )}
        <div className="header-desktop-only">
          <TokenQuotaBadge />
        </div>
        {targetApp && onTargetAppChange && (
          <div className="header-desktop-only">
            <AppTargetSelector
              value={targetApp}
              onChange={onTargetAppChange}
            />
          </div>
        )}
        {projectName && (
          <span className="main-header-project">
            <IconFolder size={11} /> {projectName}
          </span>
        )}
        <button
          type="button"
          className={`header-mobile-more-btn ${workbenchOpen || mobileToolsOpen ? "active" : ""}`}
          onClick={() => setMobileToolsOpen((v) => !v)}
          aria-expanded={mobileToolsOpen}
          aria-label="ツール・設定メニュー"
          title="エディタ・残枠・接続先メニュー"
        >
          <span aria-hidden="true">⋯</span>
          {workbenchOpen && (
            <span className="header-mobile-more-dot" aria-hidden="true" />
          )}
        </button>
      </div>

      {mobileToolsOpen && (
        <div
          className="mobile-header-sheet-backdrop"
          role="presentation"
          onClick={() => setMobileToolsOpen(false)}
        >
          <div
            className="mobile-header-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="ツールと接続先メニュー"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mobile-header-sheet-handle" aria-hidden="true" />
            <div className="mobile-header-sheet-head">
              <span className="mobile-header-sheet-title">ツール・接続先</span>
              <button
                type="button"
                className="mobile-header-sheet-close"
                onClick={() => setMobileToolsOpen(false)}
                aria-label="閉じる"
              >
                ✕
              </button>
            </div>

            <div className="mobile-header-sheet-actions">
              {onToggleWorkbench && (
                <button
                  type="button"
                  className={`mobile-sheet-action-btn ${workbenchOpen ? "active" : ""}`}
                  onClick={() => {
                    onToggleWorkbench();
                    setMobileToolsOpen(false);
                  }}
                >
                  <span>📄 {workbenchOpen ? "エディタを閉じる" : "エディタ＆ビューアを開く"}</span>
                  <span className="mobile-sheet-action-hint">MD / CSV / PDF</span>
                </button>
              )}
              {onOpenPalette && (
                <button
                  type="button"
                  className="mobile-sheet-action-btn"
                  onClick={() => {
                    setMobileToolsOpen(false);
                    onOpenPalette();
                  }}
                >
                  <span>🔍 クイック操作・AIへ即指示</span>
                  <span className="mobile-sheet-action-hint">検索 / 切替</span>
                </button>
              )}
            </div>

            {targetApp && onTargetAppChange && (
              <div className="mobile-header-sheet-section">
                <div className="mobile-header-sheet-label">接続先AIエンジン</div>
                <div className="mobile-sheet-pill-group">
                  {targetAppOptions.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`mobile-sheet-pill ${targetApp === opt.id ? "active" : ""}`}
                      onClick={() => {
                        onTargetAppChange(opt.id);
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mobile-header-sheet-section">
              <div className="mobile-header-sheet-label">⚡️ モデル利用枠 / トークン残量</div>
              <TokenQuotaBadge inlineDetails />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
