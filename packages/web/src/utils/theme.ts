/**
 * 外観テーマ管理ユーティリティ（ダーク / ライト / OS自動連動）
 */

import type { ThemeMode } from "../types";

export const DEFAULT_THEME_MODE: ThemeMode = "dark";

export function normalizeThemeMode(raw: unknown): ThemeMode {
  if (raw === "dark" || raw === "light" || raw === "auto") {
    return raw;
  }
  return DEFAULT_THEME_MODE;
}

export function resolveEffectiveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode === "light" || mode === "dark") return mode;
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return "dark";
}

export function applyThemeToDocument(mode: ThemeMode): "dark" | "light" {
  const effective = resolveEffectiveTheme(mode);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = effective;
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.style.colorScheme = effective;
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (meta) {
      meta.content = effective === "light" ? "#f8fafc" : "#0d0f13";
    }
  }
  if (typeof window !== "undefined") {
    const w = window as unknown as {
      webkit?: {
        messageHandlers?: {
          agJpNative?: { postMessage: (msg: Record<string, unknown>) => void };
        };
      };
    };
    w.webkit?.messageHandlers?.agJpNative?.postMessage({
      type: "set-theme",
      mode,
      effective,
    });
  }
  return effective;
}

export function subscribeSystemThemeChange(
  mode: ThemeMode,
  onChange: () => void,
): () => void {
  if (
    mode !== "auto" ||
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return () => {};
  }
  const mql = window.matchMedia("(prefers-color-scheme: light)");
  const handler = () => onChange();
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }
  if (typeof mql.addListener === "function") {
    mql.addListener(handler);
    return () => mql.removeListener(handler);
  }
  return () => {};
}
