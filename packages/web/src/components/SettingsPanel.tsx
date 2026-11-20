/**
 * Settings panel — global client configuration & archived chat management.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { IconChevronLeft, IconCheck } from "./Icons";
import { api } from "../api/client";
import {
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
  type BrowserNotificationPermission,
} from "../utils/browserNotifications";
import { workspaceNameFromMetadata } from "../utils/workspaceNames";
import { DEFAULT_APP_ICON_PRESET } from "../hooks/useClientSettings";
import type {
  AppTier,
  ClientSettings,
  ConversationSummary,
  ModelCatalogResponse,
  ProviderAccountInfo,
  TargetApp,
} from "../types";
import type { PlannerType } from "./ChatInput";

interface ModelConfig {
  label: string;
  modelOrAlias: { model: string };
  supportsImages: boolean;
  isRecommended: boolean;
  quotaInfo?: { remainingFraction: number };
}

interface ArchivedEntry {
  id: string;
  summary: ConversationSummary;
}

interface Props {
  settings: ClientSettings;
  onUpdate: (patch: Partial<ClientSettings>) => void;
  onBack: () => void;
  onRefreshConversations?: () => void;
  onOpenRestoredChat?: (id: string, summary: ConversationSummary) => void;
}

function formatArchiveTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "たった今";
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}日前`;
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function extractArchiveProject(summary: ConversationSummary): string | null {
  if (summary.projectName) return summary.projectName;
  const name = workspaceNameFromMetadata(summary.workspaces?.[0], {
    collapseAntigravityPlayground: true,
  });
  return name === "Others" ? null : name;
}

export function SettingsPanel({
  settings,
  onUpdate,
  onBack,
  onRefreshConversations,
  onOpenRestoredChat,
}: Props) {
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [liveDefaultModel, setLiveDefaultModel] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogResponse | null>(null);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [flashLabel, setFlashLabel] = useState("保存しました");
  const [notificationPermission, setNotificationPermission] =
    useState<BrowserNotificationPermission>(
      getBrowserNotificationPermission,
    );

  // Archived conversations state
  const [archivedItems, setArchivedItems] = useState<ArchivedEntry[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(true);
  const [archiveQuery, setArchiveQuery] = useState("");
  const [restoringId, setRestoringId] = useState<string | null>(null);

  // Project default folder settings
  const [defaultProjectFolder, setDefaultProjectFolder] = useState("");
  const [createProjectSubfolder, setCreateProjectSubfolder] = useState(false);
  const [projectSettingsSaving, setProjectSettingsSaving] = useState(false);

  // Unified Pro-tier provider account & login state
  const isProTier = (settings.appTier ?? "lite") === "pro";
  const [providers, setProviders] = useState<ProviderAccountInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerFeedback, setProviderFeedback] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);

  const fetchProviders = useCallback(async (force = false) => {
    setProvidersLoading(true);
    try {
      const res = await Promise.resolve(api.providers?.(force)).catch(
        () => null,
      );
      if (res?.providers) {
        setProviders(res.providers);
      }
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isProTier) return;
    void fetchProviders(false);
  }, [isProTier, fetchProviders]);

  const fetchModels = useCallback(async (retries = 3, forceCatalog = false) => {
    if (forceCatalog) setCatalogRefreshing(true);
    try {
      for (let i = 0; i < retries; i++) {
        try {
          const [data, catalogData] = await Promise.all([
            api.models(),
            Promise.resolve(api.modelCatalog?.(forceCatalog)).catch(() => null),
          ]);
          const configs = data.clientModelConfigs ?? [];
          setModels(configs);
          const resolvedDefault =
            data.defaultOverrideModelConfig?.modelOrAlias?.model ??
            configs[0]?.modelOrAlias?.model ??
            null;
          setLiveDefaultModel(resolvedDefault);
          if (catalogData) setCatalog(catalogData);
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
      if (forceCatalog) setCatalogRefreshing(false);
    }
  }, []);

  const fetchArchived = useCallback(async () => {
    setArchivedLoading(true);
    try {
      const data = await api.archivedConversations();
      const entries = Object.entries(data.trajectorySummaries ?? {}).map(
        ([id, summary]) => ({ id, summary }),
      );
      entries.sort(
        (a, b) =>
          new Date(b.summary.lastModifiedTime).getTime() -
          new Date(a.summary.lastModifiedTime).getTime(),
      );
      setArchivedItems(entries);
    } catch {
      setArchivedItems([]);
    } finally {
      setArchivedLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  // Auto-heal stale/retired defaultModel saved in localStorage so <select> is never unselected
  useEffect(() => {
    if (models.length === 0 || !liveDefaultModel) return;
    if (
      settings.defaultModel !== null &&
      !models.some((m) => m.modelOrAlias.model === settings.defaultModel)
    ) {
      onUpdate({ defaultModel: liveDefaultModel });
    }
  }, [models, liveDefaultModel, settings.defaultModel, onUpdate]);

  useEffect(() => {
    void fetchArchived();
  }, [fetchArchived, settings.targetApp]);

  useEffect(() => {
    let active = true;
    const loadProjectSettings = async () => {
      try {
        if (typeof api.projectSettings !== "function") return;
        const res = await api.projectSettings();
        if (!active || !res?.settings) return;
        setDefaultProjectFolder(res.settings.defaultProjectFolder ?? "");
        setCreateProjectSubfolder(Boolean(res.settings.createProjectSubfolder));
      } catch {
        // Non-fatal if endpoint unavailable
      }
    };
    void loadProjectSettings();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const syncPermission = () => {
      setNotificationPermission(getBrowserNotificationPermission());
    };

    window.addEventListener("focus", syncPermission);
    return () => window.removeEventListener("focus", syncPermission);
  }, []);

  useEffect(() => {
    if (
      settings.browserNotificationsEnabled &&
      notificationPermission !== "granted"
    ) {
      onUpdate({ browserNotificationsEnabled: false });
    }
  }, [notificationPermission, onUpdate, settings.browserNotificationsEnabled]);

  const flashSaved = useCallback((label = "保存しました") => {
    setFlashLabel(label);
    setSavedFlash(true);
    const timer = setTimeout(() => setSavedFlash(false), 1600);
    return () => clearTimeout(timer);
  }, []);

  const handleSaveProjectSettings = useCallback(
    async (nextFolder: string, nextSubfolder: boolean) => {
      if (projectSettingsSaving || typeof api.updateProjectSettings !== "function") {
        return;
      }
      setProjectSettingsSaving(true);
      try {
        const res = await api.updateProjectSettings({
          defaultProjectFolder: nextFolder.trim(),
          createProjectSubfolder: nextSubfolder,
        });
        if (res?.settings) {
          setDefaultProjectFolder(res.settings.defaultProjectFolder);
          setCreateProjectSubfolder(res.settings.createProjectSubfolder);
        }
        window.dispatchEvent(new CustomEvent("antigravity-jp:project-settings-changed"));
        flashSaved("プロジェクト設定を保存しました");
      } catch {
        flashSaved("保存に失敗しました");
      } finally {
        setProjectSettingsSaving(false);
      }
    },
    [projectSettingsSaving, flashSaved],
  );

  const handleModelChange = useCallback(
    (modelId: string) => {
      const value = modelId === "__none__" ? null : modelId;
      onUpdate({ defaultModel: value });
      flashSaved();
    },
    [onUpdate, flashSaved],
  );

  const handlePlannerChange = useCallback(
    (value: string) => {
      onUpdate({ defaultPlannerType: value as PlannerType });
      flashSaved();
    },
    [onUpdate, flashSaved],
  );

  const handleNotificationsChange = useCallback(
    async (checked: boolean) => {
      if (!checked) {
        onUpdate({ browserNotificationsEnabled: false });
        flashSaved();
        return;
      }

      const permission = await requestBrowserNotificationPermission();
      setNotificationPermission(permission);
      onUpdate({ browserNotificationsEnabled: permission === "granted" });
      flashSaved();
    },
    [onUpdate, flashSaved],
  );

  const handleTargetAppChange = useCallback(
    (value: string) => {
      onUpdate({ targetApp: value as TargetApp });
      flashSaved();
    },
    [onUpdate, flashSaved],
  );

  const handleTierChange = useCallback(
    (tier: AppTier) => {
      onUpdate({ appTier: tier });
      flashSaved(
        tier === "pro"
          ? "上位版（マルチAI）に切り替えました"
          : "シンプル版（Gemini専用）に切り替えました",
      );
    },
    [onUpdate, flashSaved],
  );

  const handleProviderLogin = useCallback(
    async (providerId: "openai" | "anthropic") => {
      setProviderFeedback(null);
      try {
        const res = await api.providerLogin(providerId);
        setProviderFeedback({
          text:
            res.message ||
            "公式ログイン画面を起動しました。サインイン後に「状態を再確認」を押してください。",
        });
      } catch (err) {
        setProviderFeedback({
          text:
            err instanceof Error
              ? err.message
              : "ログインの起動に失敗しました",
          error: true,
        });
      }
    },
    [],
  );

  const handleRestoreArchived = useCallback(
    async (entry: ArchivedEntry, openAfterRestore: boolean) => {
      setRestoringId(entry.id);
      try {
        await api.updateAnnotations(entry.id, { archived: false });
        setArchivedItems((prev) => prev.filter((item) => item.id !== entry.id));
        onRefreshConversations?.();
        if (openAfterRestore && onOpenRestoredChat) {
          onOpenRestoredChat(entry.id, entry.summary);
          return;
        }
        flashSaved("一覧に戻しました");
      } catch (err) {
        console.error("Failed to restore archived conversation:", err);
      } finally {
        setRestoringId(null);
      }
    },
    [flashSaved, onOpenRestoredChat, onRefreshConversations],
  );

  const handleReset = useCallback(() => {
    onUpdate({
      defaultModel: null,
      defaultPlannerType: "auto",
      plannerModeAutoMigrated: true,
      browserNotificationsEnabled: false,
      targetApp: "all",
      appIconPreset: DEFAULT_APP_ICON_PRESET,
    });
    flashSaved("初期値に戻しました");
  }, [onUpdate, flashSaved]);

  const filteredArchived = useMemo(() => {
    const q = archiveQuery.trim().toLowerCase();
    if (!q) return archivedItems;
    return archivedItems.filter((entry) => {
      const title = (entry.summary.summary ?? "").toLowerCase();
      const proj = (extractArchiveProject(entry.summary) ?? "").toLowerCase();
      return title.includes(q) || proj.includes(q);
    });
  }, [archivedItems, archiveQuery]);

  const notificationsChecked =
    settings.browserNotificationsEnabled &&
    notificationPermission === "granted";
  const notificationsDisabled = notificationPermission === "unsupported";
  const notificationStatus =
    notificationPermission === "unsupported"
      ? "未対応"
      : notificationPermission === "denied"
        ? "ブロック中"
        : notificationsChecked
          ? "オン"
          : "オフ";

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <button
          className="settings-back-btn"
          onClick={onBack}
          title="チャットに戻る"
        >
          <IconChevronLeft size={18} />
        </button>
        <h1 className="settings-title">設定</h1>
        <span className={`settings-saved-badge ${savedFlash ? "visible" : ""}`}>
          <IconCheck size={12} /> {flashLabel}
        </span>
      </div>

      <div className="settings-body">
        {/* ── エディション切替（下位 / 上位モデル統合） ── */}
        <div className="settings-section" data-testid="edition-tier-section">
          <h2 className="settings-section-title">表示モード（下位 / 上位モデル切替）</h2>
          <div className="tier-switcher-grid" role="radiogroup" aria-label="表示モード切替">
            <button
              type="button"
              role="radio"
              aria-checked={!isProTier}
              className={`tier-card ${!isProTier ? "active" : ""}`}
              onClick={() => handleTierChange("lite")}
            >
              <div className="tier-card-head">
                <span className="tier-card-title">🌿 シンプル版（下位）</span>
                <span className="tier-card-badge">Gemini専用</span>
              </div>
              <span className="tier-card-desc">
                Gemini（Antigravity）のみをスッキリ表示する標準モード。初めての方や普段使いにおすすめです。
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={isProTier}
              className={`tier-card ${isProTier ? "active" : ""}`}
              onClick={() => handleTierChange("pro")}
            >
              <div className="tier-card-head">
                <span className="tier-card-title">⚡ マルチAI版（上位）</span>
                <span className="tier-card-badge">他社AI連携</span>
              </div>
              <span className="tier-card-desc">
                OpenAI（ChatGPT / Codex）・Anthropic（Claude）・ローカル Ollama を各社公式ログインで追加して使い分けられます。
              </span>
            </button>
          </div>
        </div>

        {/* ── 他社AIアカウント連携（上位モード時のみ表示） ── */}
        {isProTier && (
          <div className="settings-section" data-testid="provider-accounts-section">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                marginBottom: 4,
              }}
            >
              <h2 className="settings-section-title" style={{ margin: 0 }}>
                他社AIアカウント連携（公式ログインで追加）
              </h2>
              <button
                type="button"
                className="settings-archive-btn"
                disabled={providersLoading}
                onClick={() => void fetchProviders(true)}
              >
                {providersLoading ? "確認中…" : "↻ 状態を再確認"}
              </button>
            </div>
            <span className="settings-row-desc">
              公式 CLI のブラウザ OAuth ログインを使って、追加 API 課金なしでお手持ちのサブスク枠（ChatGPT Plus/Pro・Claude Pro/Max・ローカル Ollama）を安全に追加できます。
            </span>

            {providerFeedback && (
              <div
                className={`provider-feedback-banner ${providerFeedback.error ? "error" : ""}`}
                role="status"
              >
                {providerFeedback.text}
              </div>
            )}

            <div className="provider-cards-grid">
              {providers.map((prov) => {
                const statusText =
                  prov.status === "ready"
                    ? "接続済み"
                    : prov.status === "needs_login"
                      ? "要ログイン"
                      : prov.status === "not_installed"
                        ? "CLI未導入"
                        : "オフライン";
                return (
                  <div
                    key={prov.id}
                    className={`provider-card status-${prov.status}`}
                  >
                    <div className="provider-card-top">
                      <div>
                        <div className="provider-card-name">{prov.name}</div>
                        <div className="provider-card-company">
                          {prov.company}
                        </div>
                      </div>
                      <span className={`provider-status-pill ${prov.status}`}>
                        {statusText}
                      </span>
                    </div>
                    <div className="provider-card-desc">{prov.description}</div>
                    {prov.accountHint && (
                      <div className="provider-card-meta">
                        状態: {prov.accountHint}
                        {prov.activeModel ? ` · ${prov.activeModel}` : ""}
                      </div>
                    )}
                    <div className="provider-card-actions">
                      {prov.supportsOfficialLogin &&
                        (prov.id === "openai" || prov.id === "anthropic") &&
                        prov.installed && (
                          <button
                            type="button"
                            className="provider-login-btn"
                            onClick={() =>
                              void handleProviderLogin(
                                prov.id as "openai" | "anthropic",
                              )
                            }
                          >
                            {prov.authenticated
                              ? "🔐 別アカウントで再ログイン"
                              : "🔐 ログインして追加"}
                          </button>
                        )}
                      {!prov.installed && prov.installCommand && (
                        <code className="provider-cmd-code">
                          {prov.installCommand}
                        </code>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── 日本語応答ルール ── */}
        <div className="settings-section">
          <h2 className="settings-section-title">AI 応答の日本語固定</h2>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">
                グローバル日本語ルール（~/.gemini/GEMINI.md）
              </span>
              <span className="settings-row-desc">
                AI の返答・計画書・エラー解説を常に自然な日本語にするルールをワンクリックで設定できます（既存ファイルは自動バックアップ）。
              </span>
            </div>
            <button
              type="button"
              className="approve-btn allow-conversation"
              style={{ whiteSpace: "nowrap", flexShrink: 0 }}
              onClick={() => {
                void api
                  .installJpRule()
                  .then((res) => {
                    if (res.ok) {
                      flashSaved(
                        res.alreadyInstalled
                          ? "設定済みです"
                          : "日本語ルールを設定しました",
                      );
                    }
                  })
                  .catch(() => {});
              }}
            >
              日本語ルールを設定
            </button>
          </div>
        </div>

        {/* ── 接続先AIエンジン ── */}
        <div className="settings-section">
          <h2 className="settings-section-title">接続先AIエンジン</h2>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Language Server 接続先</span>
              <span className="settings-row-desc">
                Antigravity 2、Antigravity IDE、または両方への接続を切り替えます。
              </span>
            </div>
            <select
              className="settings-select"
              value={settings.targetApp ?? "all"}
              onChange={(e) => handleTargetAppChange(e.target.value)}
            >
              <option value="all">🌐 すべてのエンジン</option>
              <option value="antigravity">🚀 Antigravity 2</option>
              <option value="antigravity-ide">⚡ Antigravity IDE</option>
            </select>
          </div>
        </div>

        {/* ── モデル ── */}
        <div className="settings-section">
          <h2 className="settings-section-title">モデル</h2>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">既定のモデル</span>
              <span className="settings-row-desc">
                メッセージごとにモデルを指定しない場合に使われる標準モデルです。変更は新しいメッセージから適用されます。
              </span>
            </div>
            <select
              className="settings-select"
              value={
                settings.defaultModel === null
                  ? "__none__"
                  : models.some((m) => m.modelOrAlias.model === settings.defaultModel)
                    ? settings.defaultModel
                    : (liveDefaultModel ?? "__none__")
              }
              onChange={(e) => handleModelChange(e.target.value)}
            >
              <option value="__none__">
                {(() => {
                  const defObj = liveDefaultModel
                    ? models.find((m) => m.modelOrAlias.model === liveDefaultModel)
                    : undefined;
                  return defObj
                    ? `サーバー標準（${defObj.label}）`
                    : "サーバー標準";
                })()}
              </option>
              {fetchError && (
                <option disabled>⚠ モデルの読み込みに失敗しました</option>
              )}
              {models.map((m) => (
                <option key={m.modelOrAlias.model} value={m.modelOrAlias.model}>
                  {m.label}
                  {m.supportsImages ? " [画像対応]" : ""}
                  {m.isRecommended ? " (推奨)" : ""}
                </option>
              ))}
            </select>
          </div>
          {catalog && (
            <div
              style={{
                marginTop: "12px",
                paddingTop: "12px",
                borderTop: "1px solid rgba(255,255,255,0.08)",
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
                  gap: "8px",
                }}
              >
                <span className="settings-row-label" style={{ fontSize: "13px" }}>
                  検出モデル一覧（自動同期）
                </span>
                <button
                  type="button"
                  className="settings-archive-btn"
                  disabled={catalogRefreshing}
                  onClick={() => void fetchModels(1, true)}
                >
                  {catalogRefreshing ? "同期中…" : "↻ 最新を取得"}
                </button>
              </div>
              {(isProTier
                ? ([
                    catalog.providers.google,
                    catalog.providers.openai,
                    catalog.providers.anthropic,
                  ] as const)
                : ([catalog.providers.google] as const)
              ).map((prov) => (
                <div
                  key={prov.provider}
                  style={{
                    padding: "8px 10px",
                    borderRadius: "8px",
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      gap: "8px",
                      flexWrap: "wrap",
                    }}
                  >
                    <strong style={{ fontSize: "12px" }}>{prov.displayName}</strong>
                    {prov.activeModelLabel && (
                      <span
                        style={{
                          fontSize: "11px",
                          color: "#34d399",
                          fontWeight: 600,
                        }}
                      >
                        現在: {prov.activeModelLabel}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "4px",
                    }}
                  >
                    {prov.models.length > 0 ? (
                      prov.models.map((m) => (
                        <span
                          key={m.id}
                          style={{
                            fontSize: "11px",
                            padding: "2px 6px",
                            borderRadius: "5px",
                            background: m.selectableInChat
                              ? "rgba(96, 165, 250, 0.14)"
                              : "rgba(255, 255, 255, 0.06)",
                            color: m.selectableInChat
                              ? "#93c5fd"
                              : "var(--text-secondary, #cbd5e1)",
                          }}
                          title={
                            m.selectableInChat
                              ? "チャットで直接選択可能"
                              : `${prov.displayName} 側で検出`
                          }
                        >
                          {m.label}
                        </span>
                      ))
                    ) : (
                      <span
                        style={{
                          fontSize: "11px",
                          color: "var(--text-tertiary, #94a3b8)",
                        }}
                      >
                        未検出
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── 実行モード（プランナー） ── */}
        <div className="settings-section">
          <h2 className="settings-section-title">実行モード</h2>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">既定のモード</span>
              <span className="settings-row-desc">
                「自動」は依頼内容に応じて高速実行と計画モードを自動で使い分けます。「高速」は即座に実行し、「計画」は手順を組み立ててから進めます。
              </span>
            </div>
            <select
              className="settings-select"
              value={settings.defaultPlannerType}
              onChange={(e) => handlePlannerChange(e.target.value)}
            >
              <option value="auto">自動（自動判別・推奨）</option>
              <option value="conversational">高速（即実行）</option>
              <option value="planning">計画（プラン作成）</option>
            </select>
          </div>
        </div>

        {/* ── プロジェクト設定 ── */}
        <div className="settings-section" data-testid="settings-project-section">
          <h2 className="settings-section-title">📁 プロジェクト</h2>
          <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: "10px" }}>
            <div className="settings-row-info">
              <span className="settings-row-label">新規プロジェクトのデフォルトフォルダ</span>
              <span className="settings-row-desc">
                サイドバーでフォルダパスを空欄のままプロジェクトを作成したときに自動適用されます（空欄のままならフォルダ紐づけなし）。<code>~/</code> 省略記法にも対応しています。
              </span>
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="text"
                className="settings-archive-search"
                style={{ flex: "1 1 220px", margin: 0 }}
                placeholder="例: ~/Projects または外付けディスクのパス（空欄でフォルダなし）"
                aria-label="新規プロジェクトのデフォルトフォルダ"
                value={defaultProjectFolder}
                onChange={(e) => setDefaultProjectFolder(e.target.value)}
                disabled={projectSettingsSaving}
              />
              <button
                type="button"
                className="settings-archive-btn primary"
                disabled={projectSettingsSaving}
                onClick={() =>
                  void handleSaveProjectSettings(
                    defaultProjectFolder,
                    createProjectSubfolder,
                  )
                }
              >
                {projectSettingsSaving ? "保存中…" : "保存"}
              </button>
              {defaultProjectFolder && (
                <button
                  type="button"
                  className="settings-archive-btn"
                  disabled={projectSettingsSaving}
                  onClick={() =>
                    void handleSaveProjectSettings("", createProjectSubfolder)
                  }
                >
                  クリア
                </button>
              )}
            </div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                fontSize: "12.5px",
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={createProjectSubfolder}
                disabled={projectSettingsSaving}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setCreateProjectSubfolder(checked);
                  void handleSaveProjectSettings(defaultProjectFolder, checked);
                }}
              />
              <span>
                空欄で作成時、デフォルトフォルダの中に「プロジェクト名」フォルダを自動作成する
              </span>
            </label>
          </div>
        </div>

        {/* ── 通知 ── */}
        <div className="settings-section">
          <h2 className="settings-section-title">通知</h2>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">ブラウザ通知</span>
              <span className="settings-row-desc">
                実行の完了時や承認リクエスト発生時に通知します。
              </span>
            </div>
            <div className="settings-notification-control">
              <span className="settings-permission-status">
                {notificationStatus}
              </span>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={notificationsChecked}
                  disabled={notificationsDisabled}
                  onChange={(e) => {
                    void handleNotificationsChange(e.target.checked);
                  }}
                  aria-label="ブラウザ通知"
                />
                <span className="settings-switch-track" />
              </label>
            </div>
          </div>
        </div>

        {/* ── アーカイブ済みチャット一覧 & 復元 ── */}
        <div className="settings-section">
          <div className="settings-section-header-row">
            <h2 className="settings-section-title">📦 アーカイブ</h2>
            <span className="settings-archive-count">
              {archivedLoading ? "読込中…" : `${archivedItems.length}件`}
            </span>
          </div>
          <p className="settings-archive-desc">
            アーカイブしたチャットの一覧です。「取り出す」で元のサイドバーに戻せます。
          </p>

          {archivedItems.length >= 4 && (
            <input
              type="text"
              className="settings-archive-search"
              placeholder="アーカイブ内を検索..."
              value={archiveQuery}
              onChange={(e) => setArchiveQuery(e.target.value)}
            />
          )}

          {archivedLoading ? (
            <div className="settings-archive-empty">
              アーカイブを読み込んでいます...
            </div>
          ) : filteredArchived.length === 0 ? (
            <div className="settings-archive-empty">
              {archiveQuery.trim()
                ? `「${archiveQuery}」に一致するアーカイブはありません`
                : "アーカイブ済みのチャットはありません"}
            </div>
          ) : (
            <div className="settings-archive-list">
              {filteredArchived.map((entry) => {
                const title = entry.summary.summary || entry.id.slice(0, 8);
                const proj = extractArchiveProject(entry.summary);
                const timeStr = formatArchiveTime(entry.summary.lastModifiedTime);
                const busy = restoringId === entry.id;

                return (
                  <div key={entry.id} className="settings-archive-item">
                    <div className="settings-archive-info">
                      <span className="settings-archive-title" title={title}>
                        {title}
                      </span>
                      <span className="settings-archive-meta">
                        {timeStr}
                        {entry.summary.stepCount > 0
                          ? ` · ${entry.summary.stepCount} ステップ`
                          : ""}
                        {proj ? ` · ${proj}` : ""}
                      </span>
                    </div>
                    <div className="settings-archive-actions">
                      <button
                        type="button"
                        className="settings-archive-btn primary"
                        disabled={busy}
                        onClick={() => void handleRestoreArchived(entry, false)}
                        title="アーカイブを解除してサイドバーに戻す"
                      >
                        {busy ? "処理中…" : "取り出す"}
                      </button>
                      {onOpenRestoredChat && (
                        <button
                          type="button"
                          className="settings-archive-btn"
                          disabled={busy}
                          onClick={() => void handleRestoreArchived(entry, true)}
                          title="アーカイブから取り出してすぐに開く"
                        >
                          開く
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── リセット ── */}
        <button className="settings-reset-btn" onClick={handleReset}>
          設定をすべて初期値に戻す
        </button>
      </div>
    </div>
  );
}
