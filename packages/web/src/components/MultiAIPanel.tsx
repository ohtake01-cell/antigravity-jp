import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type {
  ExternalProviderId,
  MultiAISession,
  ProviderAccountInfo,
} from "../types";

interface Props {
  currentWorkspaceUri?: string | null;
  initialSessionId?: string | null;
  onBackToGemini: () => void;
  onOpenSettings: () => void;
}

const PROVIDER_LABELS: Record<ExternalProviderId, string> = {
  openai: "OpenAI (Codex)",
  anthropic: "Anthropic (Claude)",
  ollama: "ローカル (Ollama)",
};

const PROVIDER_ICONS: Record<ExternalProviderId, string> = {
  openai: "🟢",
  anthropic: "🟣",
  ollama: "🌱",
};

function statusLabel(status: ProviderAccountInfo["status"]): string {
  switch (status) {
    case "ready":
      return "接続済み";
    case "needs_login":
      return "要ログイン";
    case "not_installed":
      return "CLI未導入";
    case "offline":
      return "オフライン";
  }
}

export function MultiAIPanel({
  currentWorkspaceUri,
  initialSessionId,
  onBackToGemini,
  onOpenSettings,
}: Props) {
  const [providers, setProviders] = useState<ProviderAccountInfo[]>([]);
  const [sessions, setSessions] = useState<MultiAISession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialSessionId ?? null,
  );
  const [mobileChatOpen, setMobileChatOpen] = useState(Boolean(initialSessionId));
  const [composerProvider, setComposerProvider] =
    useState<ExternalProviderId>("openai");
  const [composerModel, setComposerModel] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [loginFeedback, setLoginFeedback] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadAll = useCallback(async (forceProviders = false) => {
    if (forceProviders) setRefreshing(true);
    try {
      const [provRes, sessRes] = await Promise.all([
        api.providers(forceProviders).catch(() => null),
        api.providerSessions().catch(() => null),
      ]);
      if (provRes?.providers) {
        setProviders(provRes.providers);
      }
      if (sessRes?.sessions) {
        setSessions(sessRes.sessions);
      }
    } finally {
      if (forceProviders) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadAll(false);
  }, [loadAll]);

  useEffect(() => {
    if (initialSessionId) {
      setSelectedSessionId(initialSessionId);
      setMobileChatOpen(true);
    }
  }, [initialSessionId]);

  const hasRunning = sessions.some((s) => s.status === "running");
  useEffect(() => {
    const interval = window.setInterval(
      () => {
        void api
          .providerSessions()
          .then((res) => {
            if (res?.sessions) setSessions(res.sessions);
          })
          .catch(() => {});
      },
      hasRunning ? 2_000 : 12_000,
    );
    return () => window.clearInterval(interval);
  }, [hasRunning]);

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  const activeProviderInfo = useMemo(
    () =>
      providers.find(
        (p) => p.id === (selectedSession?.provider ?? composerProvider),
      ) ?? null,
    [providers, selectedSession?.provider, composerProvider],
  );

  const workspaceDir = useMemo(() => {
    if (!currentWorkspaceUri?.startsWith("file://")) return undefined;
    try {
      return decodeURIComponent(new URL(currentWorkspaceUri).pathname);
    } catch {
      return undefined;
    }
  }, [currentWorkspaceUri]);

  const handleLogin = useCallback(async (id: "openai" | "anthropic") => {
    setLoginFeedback(null);
    try {
      const res = await api.providerLogin(id);
      setLoginFeedback({
        text:
          res.message ||
          "ログイン処理を起動しました。完了後「↻ 更新」を押してください。",
      });
    } catch (err) {
      setLoginFeedback({
        text: err instanceof Error ? err.message : "ログイン起動に失敗しました",
        error: true,
      });
    }
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setLoginFeedback(null);
    try {
      if (selectedSession) {
        const res = await api.sendProviderSessionMessage(selectedSession.id, {
          prompt: trimmed,
          model: composerModel || selectedSession.model || undefined,
        });
        setSessions((prev) =>
          prev.map((s) => (s.id === res.session.id ? res.session : s)),
        );
      } else {
        const res = await api.createProviderSession({
          provider: composerProvider,
          model: composerModel || activeProviderInfo?.activeModel || undefined,
          prompt: trimmed,
          workspaceDir,
        });
        setSessions((prev) => [res.session, ...prev]);
        setSelectedSessionId(res.session.id);
        setMobileChatOpen(true);
      }
      setPrompt("");
    } catch (err) {
      setLoginFeedback({
        text: err instanceof Error ? err.message : "送信に失敗しました",
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }, [
    prompt,
    busy,
    selectedSession,
    composerModel,
    composerProvider,
    activeProviderInfo?.activeModel,
    workspaceDir,
  ]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await api.deleteProviderSession(id);
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (selectedSessionId === id) {
          setSelectedSessionId(null);
          setMobileChatOpen(false);
        }
      } catch {
        // ignore
      }
    },
    [selectedSessionId],
  );

  return (
    <div className="multi-ai-panel" data-testid="multi-ai-panel">
      <div className="multi-ai-top-bar">
        <div className="multi-ai-provider-strip">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`multi-ai-chip ${
                p.id !== "google" &&
                (selectedSession?.provider ?? composerProvider) === p.id
                  ? "active"
                  : ""
              }`}
              onClick={() => {
                if (p.id === "google") {
                  onBackToGemini();
                  return;
                }
                setSelectedSessionId(null);
                setComposerProvider(p.id);
                setComposerModel(p.activeModel ?? "");
                setMobileChatOpen(true);
              }}
              title={p.description}
            >
              <span className={`multi-ai-chip-dot ${p.status}`} />
              <span>{p.name}</span>
              <span style={{ fontSize: 10.5, opacity: 0.75 }}>
                ({statusLabel(p.status)})
              </span>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            className="settings-archive-btn"
            disabled={refreshing}
            onClick={() => void loadAll(true)}
          >
            {refreshing ? "更新中…" : "↻ 更新"}
          </button>
          <button
            type="button"
            className="settings-archive-btn"
            onClick={onOpenSettings}
          >
            🔐 連携設定
          </button>
        </div>
      </div>

      {loginFeedback && (
        <div style={{ padding: "0 14px" }}>
          <div
            className={`provider-feedback-banner ${loginFeedback.error ? "error" : ""}`}
          >
            {loginFeedback.text}
          </div>
        </div>
      )}

      <div
        className={`multi-ai-body ${mobileChatOpen ? "mobile-chat-open" : ""}`}
      >
        <div className="multi-ai-sessions-col">
          <button
            type="button"
            className="provider-login-btn"
            style={{ width: "100%", textAlign: "center" }}
            onClick={() => {
              setSelectedSessionId(null);
              setMobileChatOpen(true);
            }}
          >
            ＋ 新しい他社AIチャット
          </button>

          {sessions.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                color: "var(--text-tertiary, #94a3b8)",
                padding: "14px 6px",
                lineHeight: 1.5,
              }}
            >
              まだマルチAIセッションはありません。上のプロバイダー（OpenAI / Claude / Ollama）を選んで話しかけてください。
            </div>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                className={`multi-ai-session-item ${s.id === selectedSessionId ? "active" : ""}`}
                onClick={() => {
                  setSelectedSessionId(s.id);
                  setMobileChatOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedSessionId(s.id);
                    setMobileChatOpen(true);
                  }
                }}
              >
                <div className="multi-ai-session-head">
                  <span className="multi-ai-session-title">
                    {PROVIDER_ICONS[s.provider]} {s.title}
                  </span>
                  <button
                    type="button"
                    aria-label="セッション削除"
                    title="削除"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(s.id);
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--text-tertiary, #94a3b8)",
                      cursor: "pointer",
                      fontSize: 12,
                      padding: "0 4px",
                    }}
                  >
                    ✕
                  </button>
                </div>
                <div className="multi-ai-session-meta">
                  <span>
                    {PROVIDER_LABELS[s.provider]}
                    {s.model ? ` · ${s.model}` : ""}
                  </span>
                  <span>
                    {s.status === "running"
                      ? "⚡ 応答中"
                      : s.status === "error"
                        ? "⚠️ エラー"
                        : `${s.messages.length}件`}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="multi-ai-chat-col">
          <div className="multi-ai-chat-scroll">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <button
                type="button"
                className="multi-ai-mobile-back"
                onClick={() => setMobileChatOpen(false)}
              >
                ← セッション一覧
              </button>
              {selectedSession && (
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--text-tertiary, #94a3b8)",
                  }}
                >
                  {PROVIDER_ICONS[selectedSession.provider]}{" "}
                  {PROVIDER_LABELS[selectedSession.provider]}
                  {selectedSession.model ? ` (${selectedSession.model})` : ""}
                </span>
              )}
            </div>

            {selectedSession ? (
              <>
                {selectedSession.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`multi-ai-msg ${m.role} ${m.error ? "error" : ""}`}
                  >
                    {m.content}
                  </div>
                ))}
                {selectedSession.status === "running" && (
                  <div className="multi-ai-msg assistant">
                    <div className="typing-indicator">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>
                  ⚡ マルチAIハブ（上位モード）
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--text-secondary, #94a3b8)",
                    lineHeight: 1.55,
                  }}
                >
                  OpenAI（ChatGPT / Codex）・Anthropic（Claude Code）・ローカル Ollama を公式ログインのまま追加して対話できます。Gemini の標準チャットに戻るには左の「新規チャット」または上の「Gemini」を押してください。
                </div>
                <div className="provider-cards-grid">
                  {providers
                    .filter((p) => p.id !== "google")
                    .map((p) => (
                      <div
                        key={p.id}
                        className={`provider-card status-${p.status}`}
                      >
                        <div className="provider-card-top">
                          <div>
                            <div className="provider-card-name">{p.name}</div>
                            <div className="provider-card-company">
                              {p.company}
                            </div>
                          </div>
                          <span className={`provider-status-pill ${p.status}`}>
                            {statusLabel(p.status)}
                          </span>
                        </div>
                        <div className="provider-card-desc">{p.description}</div>
                        {p.accountHint && (
                          <div className="provider-card-meta">
                            状態: {p.accountHint}
                          </div>
                        )}
                        <div className="provider-card-actions">
                          {p.status === "ready" ? (
                            <button
                              type="button"
                              className="provider-login-btn"
                              onClick={() => {
                                setComposerProvider(p.id as ExternalProviderId);
                                setComposerModel(p.activeModel ?? "");
                              }}
                            >
                              このAIを選択
                            </button>
                          ) : p.supportsOfficialLogin && p.installed ? (
                            <button
                              type="button"
                              className="provider-login-btn"
                              onClick={() =>
                                void handleLogin(
                                  p.id as "openai" | "anthropic",
                                )
                              }
                            >
                              🔐 ログインして連携
                            </button>
                          ) : p.installCommand ? (
                            <code className="provider-cmd-code">
                              {p.installCommand}
                            </code>
                          ) : null}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>

          <div className="multi-ai-composer">
            <div className="multi-ai-composer-controls">
              {!selectedSession && (
                <select
                  className="settings-select"
                  aria-label="送信先AIプロバイダー"
                  value={composerProvider}
                  onChange={(e) => {
                    const next = e.target.value as ExternalProviderId;
                    setComposerProvider(next);
                    const info = providers.find((p) => p.id === next);
                    setComposerModel(info?.activeModel ?? "");
                  }}
                >
                  <option value="openai">🟢 OpenAI / ChatGPT (Codex)</option>
                  <option value="anthropic">🟣 Anthropic / Claude</option>
                  <option value="ollama">🌱 ローカル AI (Ollama)</option>
                </select>
              )}
              {activeProviderInfo && activeProviderInfo.models.length > 0 && (
                <select
                  className="settings-select"
                  aria-label="使用モデル"
                  value={composerModel || activeProviderInfo.activeModel || ""}
                  onChange={(e) => setComposerModel(e.target.value)}
                >
                  {activeProviderInfo.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="multi-ai-composer-row">
              <textarea
                className="multi-ai-textarea"
                rows={2}
                placeholder={`${PROVIDER_LABELS[selectedSession?.provider ?? composerProvider]} に質問・依頼を入力… (⌘Enter で送信)`}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    (e.metaKey || e.ctrlKey) &&
                    e.key === "Enter" &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <button
                type="button"
                className="approve-btn allow-conversation"
                disabled={busy || !prompt.trim() || selectedSession?.status === "running"}
                onClick={() => void handleSend()}
                style={{ height: 42, padding: "0 16px", flexShrink: 0 }}
              >
                {busy || selectedSession?.status === "running" ? "送信中…" : "送信"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
