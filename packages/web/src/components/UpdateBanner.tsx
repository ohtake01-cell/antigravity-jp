/**
 * アプリ上部に控えめに表示するアップデート通知・進捗バー
 */

import { formatBytesMb, type AppUpdateState } from "../hooks/useAppUpdate";

interface Props {
  state: AppUpdateState;
  isBusy: boolean;
  onInstall: () => void;
  onOpenRelease: () => void;
  onDismiss: () => void;
}

export function UpdateBanner({
  state,
  isBusy,
  onInstall,
  onOpenRelease,
  onDismiss,
}: Props) {
  const pct = Math.round(Math.min(1, Math.max(0, state.progress)) * 100);

  return (
    <div
      className={`update-banner ${isBusy ? "busy" : ""}`}
      role="status"
      data-testid="app-update-banner"
    >
      <div className="update-banner-main">
        <span className="update-banner-badge">
          {isBusy ? "🔄 更新中" : "✨ 新バージョン"}
        </span>
        <span className="update-banner-text">
          {state.phase === "downloading"
            ? `v${state.latestVersion ?? ""} をダウンロード中… ${pct}%${
                state.totalBytes > 0
                  ? ` (${formatBytesMb(state.downloadedBytes)} / ${formatBytesMb(state.totalBytes)})`
                  : ""
              }`
            : state.phase === "verifying"
              ? "パッケージを展開・署名検証しています…"
              : state.phase === "restarting"
                ? "アプリを入れ替えて自動再起動しています…"
                : `Antigravity 日本語版 v${state.latestVersion} が利用可能です（現在 v${state.currentVersion}）`}
        </span>
      </div>

      {state.phase === "downloading" && (
        <div className="update-banner-progress-track" aria-hidden="true">
          <div
            className="update-banner-progress-fill"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {!isBusy && (
        <div className="update-banner-actions">
          <button
            type="button"
            className="update-banner-btn primary"
            onClick={onInstall}
          >
            {state.canAutoInstall
              ? "今すぐアップデートして再起動"
              : "ダウンロードページを開く"}
          </button>
          {state.canAutoInstall && (
            <button
              type="button"
              className="update-banner-btn"
              onClick={onOpenRelease}
            >
              変更内容
            </button>
          )}
          <button
            type="button"
            className="update-banner-btn ghost"
            onClick={onDismiss}
            aria-label="アップデート通知を閉じる"
          >
            後で
          </button>
        </div>
      )}
    </div>
  );
}
