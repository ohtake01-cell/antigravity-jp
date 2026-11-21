/**
 * Antigravity 日本語版 自動アップデート連携フック
 *
 * - macOS ネイティブアプリ内では WKWebView の agJpNative ブリッジと同期し、
 *   ワンクリックダウンロード・SHA-256/署名検証・自動入れ替え＆再起動を制御する。
 * - 通常ブラウザ表示時は /api/update/check にフォールバックし、最新版の通知と
 *   GitHub Releases ページ案内を行う。
 */

import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "up_to_date"
  | "downloading"
  | "verifying"
  | "installing"
  | "restarting"
  | "error";

export interface AppUpdateState {
  isNativeApp: boolean;
  currentVersion: string;
  latestVersion?: string | null;
  updateAvailable: boolean;
  canAutoInstall: boolean;
  autoInstallBlockedReason?: string | null;
  phase: AppUpdatePhase;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  releaseName?: string | null;
  releaseNotes?: string | null;
  releaseUrl: string;
  downloadUrl?: string | null;
  autoCheckEnabled: boolean;
  message?: string | null;
  error?: string | null;
}

const DEFAULT_RELEASES_URL =
  "https://github.com/ohtake01-cell/antigravity-jp/releases";
const DISMISSED_VERSION_KEY = "antigravity-jp:dismissedUpdateVersion";

declare global {
  interface Window {
    __AG_JP_UPDATE_STATE__?: Partial<AppUpdateState>;
    webkit?: {
      messageHandlers?: {
        agJpNative?: {
          postMessage: (payload: Record<string, unknown>) => void;
        };
      };
    };
  }
}

function getNativeHandler() {
  return window.webkit?.messageHandlers?.agJpNative ?? null;
}

function normalizeState(raw?: Partial<AppUpdateState>): AppUpdateState {
  return {
    isNativeApp: Boolean(raw?.isNativeApp ?? getNativeHandler()),
    currentVersion: raw?.currentVersion || "1.5.0",
    latestVersion: raw?.latestVersion ?? null,
    updateAvailable: Boolean(raw?.updateAvailable),
    canAutoInstall: Boolean(raw?.canAutoInstall),
    autoInstallBlockedReason: raw?.autoInstallBlockedReason ?? null,
    phase: raw?.phase ?? "idle",
    progress: typeof raw?.progress === "number" ? raw.progress : 0,
    downloadedBytes:
      typeof raw?.downloadedBytes === "number" ? raw.downloadedBytes : 0,
    totalBytes: typeof raw?.totalBytes === "number" ? raw.totalBytes : 0,
    releaseName: raw?.releaseName ?? null,
    releaseNotes: raw?.releaseNotes ?? null,
    releaseUrl: raw?.releaseUrl || DEFAULT_RELEASES_URL,
    downloadUrl: raw?.downloadUrl ?? null,
    autoCheckEnabled: raw?.autoCheckEnabled ?? true,
    message: raw?.message ?? null,
    error: raw?.error ?? null,
  };
}

export function formatBytesMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function useAppUpdate() {
  const [state, setState] = useState<AppUpdateState>(() =>
    normalizeState(window.__AG_JP_UPDATE_STATE__),
  );
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(DISMISSED_VERSION_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    const onNativeStatus = (ev: Event) => {
      const detail = (ev as CustomEvent<Partial<AppUpdateState>>).detail;
      if (detail && typeof detail === "object") {
        setState(normalizeState(detail));
      }
    };
    window.addEventListener("antigravity-jp:update-status", onNativeStatus);

    const native = getNativeHandler();
    if (native) {
      native.postMessage({ type: "update-get-state" });
    } else {
      // ブラウザ単体アクセス時: 控えめに 1 回だけ最新状態を取得
      void api
        .checkUpdate(false)
        .then((res) => {
          setState((prev) => ({
            ...prev,
            isNativeApp: false,
            currentVersion: res.currentVersion,
            latestVersion: res.latestVersion,
            updateAvailable: res.updateAvailable,
            canAutoInstall: false,
            phase: res.error
              ? "error"
              : res.updateAvailable
                ? "available"
                : "up_to_date",
            releaseName: res.releaseName,
            releaseNotes: res.releaseNotes,
            releaseUrl: res.releaseUrl || DEFAULT_RELEASES_URL,
            downloadUrl: res.zipAsset?.downloadUrl ?? res.dmgAsset?.downloadUrl ?? null,
            message: res.updateAvailable
              ? `新しいバージョン v${res.latestVersion} が利用可能です。`
              : `最新バージョン（v${res.currentVersion}）です。`,
            error: res.error ?? null,
          }));
        })
        .catch(() => {
          // オフライン時は静かに無視
        });
    }

    return () => {
      window.removeEventListener("antigravity-jp:update-status", onNativeStatus);
    };
  }, []);

  const checkForUpdates = useCallback(async (force = true) => {
    setDismissedVersion(null);
    const native = getNativeHandler();
    if (native) {
      native.postMessage({ type: "update-check", showDialog: false });
      return;
    }
    setState((prev) => ({
      ...prev,
      phase: "checking",
      error: null,
      message: "最新バージョンを確認しています…",
    }));
    try {
      const res = await api.checkUpdate(force);
      setState((prev) => ({
        ...prev,
        isNativeApp: false,
        currentVersion: res.currentVersion,
        latestVersion: res.latestVersion,
        updateAvailable: res.updateAvailable,
        canAutoInstall: false,
        phase: res.error
          ? "error"
          : res.updateAvailable
            ? "available"
            : "up_to_date",
        releaseName: res.releaseName,
        releaseNotes: res.releaseNotes,
        releaseUrl: res.releaseUrl || DEFAULT_RELEASES_URL,
        downloadUrl: res.zipAsset?.downloadUrl ?? res.dmgAsset?.downloadUrl ?? null,
        message: res.updateAvailable
          ? `新しいバージョン v${res.latestVersion} が利用可能です。`
          : `最新バージョン（v${res.currentVersion}）をお使いです。`,
        error: res.error ?? null,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        phase: "error",
        error:
          err instanceof Error
            ? err.message
            : "アップデート確認に失敗しました",
      }));
    }
  }, []);

  const installUpdate = useCallback(() => {
    const native = getNativeHandler();
    if (native && state.canAutoInstall) {
      native.postMessage({ type: "update-install" });
      return;
    }
    window.open(state.releaseUrl || DEFAULT_RELEASES_URL, "_blank", "noopener");
  }, [state.canAutoInstall, state.releaseUrl]);

  const openReleasePage = useCallback(() => {
    const native = getNativeHandler();
    if (native) {
      native.postMessage({ type: "update-open-release" });
      return;
    }
    window.open(state.releaseUrl || DEFAULT_RELEASES_URL, "_blank", "noopener");
  }, [state.releaseUrl]);

  const setAutoCheckEnabled = useCallback((enabled: boolean) => {
    const native = getNativeHandler();
    if (native) {
      native.postMessage({ type: "update-set-auto-check", enabled });
    }
    setState((prev) => ({ ...prev, autoCheckEnabled: enabled }));
  }, []);

  const dismissBanner = useCallback(() => {
    if (state.latestVersion) {
      setDismissedVersion(state.latestVersion);
      try {
        sessionStorage.setItem(DISMISSED_VERSION_KEY, state.latestVersion);
      } catch {
        // 無視
      }
    }
  }, [state.latestVersion]);

  const isBusy =
    state.phase === "downloading" ||
    state.phase === "verifying" ||
    state.phase === "installing" ||
    state.phase === "restarting";

  const showBanner =
    isBusy ||
    (state.updateAvailable &&
      Boolean(state.latestVersion) &&
      dismissedVersion !== state.latestVersion);

  return {
    state,
    isBusy,
    showBanner,
    checkForUpdates,
    installUpdate,
    openReleasePage,
    setAutoCheckEnabled,
    dismissBanner,
  } as const;
}
