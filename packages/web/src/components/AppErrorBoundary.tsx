import {
  Component,
  lazy,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";

const CHUNK_RELOAD_KEY = "app:chunk-reload-ts";
const CHUNK_RELOAD_COOLDOWN_MS = 15_000;

/** 動的インポート（Vite 遅延チャンク）の更新ズレによる読み込み失敗かどうか判定 */
export function isChunkLoadError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === "string"
        ? error
        : "";
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk \d+ failed|Unable to preload CSS/i.test(
    msg,
  );
}

/** 連続リロードループを防ぎつつ、古いチャンク検出時に1回だけ自動リロードする */
export function reloadOnceForStaleChunk(): boolean {
  try {
    const now = Date.now();
    const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? "0");
    if (Number.isFinite(last) && now - last < CHUNK_RELOAD_COOLDOWN_MS) {
      return false;
    }
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

/**
 * React.lazy の安全ラッパー。
 * アプリ更新後に旧画面から遅延パネル（タスクログ・設定等）を開いてチャンクが404になっても、
 * 真っ暗にクラッシュさせず自動で最新版へ再読み込みする。
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    factory().catch((err: unknown) => {
      if (isChunkLoadError(err) && reloadOnceForStaleChunk()) {
        return new Promise<{ default: T }>(() => {});
      }
      throw err;
    }),
  );
}

interface BoundaryProps {
  children: ReactNode;
  variant?: "app" | "panel";
  title?: string;
  onClose?: () => void;
}

interface BoundaryState {
  error: Error | null;
}

/**
 * 画面全体・パネル個別の安全ネット（ErrorBoundary）。
 * 予期しない例外や遅延チャンク読み込み失敗が発生しても、
 * 画面を真っ暗にせず日本語の復旧UIを表示する。
 */
export class AppErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[AppErrorBoundary]", error, info.componentStack);
    if (isChunkLoadError(error)) {
      reloadOnceForStaleChunk();
    }
  }

  private handleReload = () => {
    try {
      sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    } catch {
      // ignore
    }
    window.location.reload();
  };

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const isPanel = this.props.variant === "panel";
    const isChunk = isChunkLoadError(error);
    const heading =
      this.props.title ??
      (isChunk
        ? "アプリが最新版に更新されました"
        : isPanel
          ? "パネルの表示中にエラーが発生しました"
          : "画面の表示中にエラーが発生しました");
    const description = isChunk
      ? "画面を再読み込みすると最新バージョンで正常に開きます。"
      : error.message || "予期しないエラーが発生しました。再読み込みをお試しください。";

    if (isPanel) {
      return (
        <aside
          className="wb-pane agent-monitor-pane"
          role="alert"
          data-testid="panel-error-boundary"
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            gap: 12,
            padding: 24,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
            ⚠️ {heading}
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--text-secondary)",
              maxWidth: 320,
              lineHeight: 1.55,
              wordBreak: "break-word",
            }}
          >
            {description}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button
              type="button"
              className="btn-primary"
              style={{ padding: "6px 14px", borderRadius: 8, cursor: "pointer" }}
              onClick={this.handleReload}
            >
              再読み込み
            </button>
            {this.props.onClose ? (
              <button
                type="button"
                className="wb-open-btn secondary"
                style={{ padding: "6px 14px", borderRadius: 8, cursor: "pointer" }}
                onClick={() => {
                  this.handleRetry();
                  this.props.onClose?.();
                }}
              >
                閉じる
              </button>
            ) : (
              <button
                type="button"
                className="wb-open-btn secondary"
                style={{ padding: "6px 14px", borderRadius: 8, cursor: "pointer" }}
                onClick={this.handleRetry}
              >
                再試行
              </button>
            )}
          </div>
        </aside>
      );
    }

    return (
      <div
        role="alert"
        data-testid="app-error-boundary"
        style={{
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: 24,
          background: "var(--bg-primary, #0d1117)",
          color: "var(--text-primary, #f1f5f9)",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700 }}>⚠️ {heading}</div>
        <div
          style={{
            fontSize: 13,
            color: "var(--text-secondary, #94a3b8)",
            maxWidth: 440,
            lineHeight: 1.6,
            wordBreak: "break-word",
          }}
        >
          {description}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: "8px 18px",
              borderRadius: 9,
              border: "none",
              background: "#3b82f6",
              color: "#ffffff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            画面を再読み込み
          </button>
          <button
            type="button"
            onClick={this.handleRetry}
            style={{
              padding: "8px 16px",
              borderRadius: 9,
              border: "1px solid rgba(148, 163, 184, 0.3)",
              background: "transparent",
              color: "var(--text-primary, #e2e8f0)",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            そのまま再試行
          </button>
        </div>
      </div>
    );
  }
}
