/**
 * Global client settings stored in localStorage.
 *
 * A single key (`porta:settings`) holds all settings across workspaces.
 * Cross-tab sync via the `storage` event.
 */

import { useState, useEffect, useCallback } from "react";
import type { AppIconPreset, ClientSettings } from "../types";
import { DEFAULT_MODEL } from "../constants";

const STORAGE_KEY = "porta:settings";

export const DEFAULT_APP_ICON_PRESET: AppIconPreset = "option1_official_orb";

export const APP_ICON_PRESETS: ReadonlyArray<{
  id: AppIconPreset;
  label: string;
}> = [
  { id: "option1_official_orb", label: "案1：公式オーブ" },
  { id: "option2_neural_horizon", label: "案2：5AI星座" },
  { id: "option3_starry_owl", label: "案3：星夜のフクロウ" },
  { id: "option4_minimal_n", label: "案4：ミニマルN" },
];

export function getAppIconUrl(_preset?: AppIconPreset): string {
  return `${import.meta.env.BASE_URL}icons/icon-192.png`;
}

const DEFAULT_SETTINGS: ClientSettings = {
  defaultModel: DEFAULT_MODEL,
  defaultPlannerType: "auto",
  localPermissionPolicy: "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER",
  plannerModeAutoMigrated: true,
  browserNotificationsEnabled: false,
  targetApp: "all",
  appTier: "lite",
  appIconPreset: DEFAULT_APP_ICON_PRESET,
};

function readSettings(): ClientSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<ClientSettings>;
    const merged: ClientSettings = { ...DEFAULT_SETTINGS, ...parsed };
    if (!parsed.plannerModeAutoMigrated) {
      merged.defaultPlannerType = "auto";
      merged.plannerModeAutoMigrated = true;
      writeSettings(merged);
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings: ClientSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or unavailable — silently degrade
  }
}

export function useClientSettings() {
  const [settings, setSettings] = useState<ClientSettings>(readSettings);

  // Listen for cross-tab storage events
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setSettings(readSettings());
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const updateSettings = useCallback((patch: Partial<ClientSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      writeSettings(next);
      return next;
    });
  }, []);

  return { settings, updateSettings } as const;
}
