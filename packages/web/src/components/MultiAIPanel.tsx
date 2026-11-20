import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { renderMarkdown } from "../utils/markdown";
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

type PanelMode = "chat" | "compare";

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

const QUICK_PRESETS: ReadonlyArray<{ label: string; prefix: string }> = [
  {
    label: "🔍 設計レビュー",
    prefix: "以下の設計・コードについて、改善点とリスクを3点に絞ってレビューしてください:\n\n",
  },
  {
    label: "⚖️ メリデメ比較",
    prefix: "以下の選択肢について、メリット・デメリットとおすすめ案を表で比較してください:\n\n",
  },
  {
    label: "📝 要約・整理",
    prefix: "以下の内容を箇条書き3〜5行で分かりやすく要約・整理してください:\n\n",
  },
  {
    label: "🛠️ バグ切り分け",
    prefix: "以下の症状の原因候補と、最短の確認手順を優先度順に教えてください:\n\n",
  },
];

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

function formatElapsed(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}秒`;
}

export function MultiAIPanel({
  currentWorkspaceUri,
  initialSessionId,
  onBackToGemini,
  onOpenSettings,
}: Props) {
  const [mode, setMode] = useState<PanelMode>("chat");
  const [providers, setProviders] = useState<ProviderAccountInfo[]>([]);
  const [sessions, setSessions] = useState<MultiAISession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialSessionId ?? null,
  );
  const [mobileChatOpen, setMobileChatOpen] = useState(
    Boolean(initialSessionId),
  );
  const [composerProvider, setComposerProvider] =
    useState<ExternalProviderId>("openai");
  const [composerModel, setComposerModel] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [loginFeedback, setLoginFeedback] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Parallel Compare mode state
  const [compareTargets, setCompareTargets] = useState<ExternalProviderId[]>([
    "openai",
    "anthropic",
  ]);
  const [activeCompareGroupId, setActiveCompareGroupId] = useState<
    string | null
  >(null);

  const loadAll = useCallback(async (forceProviders = false) => {
    if (forceProviders) setRefreshing(true);
    try {
      const [provRes, sessRes] = await Promise.all([
        api.providers(forceProviders).catch(() => null),
        api.providerSessions().catch(() => null),
      ]);
      if (provRes?.providers) {
        setProviders(provRes.providers);
        const readyExternal = provRes.providers
          .filter((p) => p.id !== "google" && p.status === "ready")
          .map((p) => p.id as ExternalProviderId);
        if (readyExternal.length >= 2) {
          setCompareTargets((prev) =>
            prev.length >= 2 ? prev : readyExternal,
          );
        }
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
      setMode("chat");
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

  // Latest comparison group (either user-triggered or most recent compareGroupId in sessions)
  const compareGroups = useMemo(() => {
    const map = new Map<string, MultiAISession[]>();
    for (const s of sessions) {
      if (!s.compareGroupId) continue;
      const list = map.get(s.compareGroupId) ?? [];
      list.push(s);
      map.set(s.compareGroupId, list);
    }
    return Array.from(map.entries()).map(([groupId, items]) => ({
      groupId,
      title: items[0]?.title ?? "並列比較",
      prompt: items[0]?.messages[0]?.content ?? "",
      updatedAt: items[0]?.updatedAt ?? "",
      items,
    }));
  }, [sessions]);

  const activeCompareGroup = useMemo(() => {
    if (activeCompareGroupId) {
      const hit = compareGroups.find((g) => g.groupId === activeCompareGroupId);
      if (hit) return hit;
    }
    return compareGroups[0] ?? null;
  }, [compareGroups, activeCompareGroupId]);

  const workspaceDir = useMemo(() => {
    if (!currentWorkspaceUri?.startsWith("file://")) return undefined;
    try {
      return decodeURIComponent(new URL(currentWorkspaceUri).pathname);
    } catch {
      return undefined;
    }
  }, [currentWorkspaceUri]);

  const handleCopyText = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev));
      }, 1500);
    } catch {
      // ignore clipboard restriction
    }
  }, []);

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

  const handleRetry = useCallback(async (sessionId: string) => {
    setLoginFeedback(null);
    try {
      const res = await api.retryProviderSession(sessionId);
      setSessions((prev) =>
        prev.map((s) => (s.id === res.session.id ? res.session : s)),
      );
    } catch (err) {
      setLoginFeedback({
        text: err instanceof Error ? err.message : "再試行に失敗しました",
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
      if (mode === "compare") {
        if (compareTargets.length < 2) {
          setLoginFeedback({
            text: "並列比較には 2 つ以上の AI を選択してください。",
            error: true,
          });
          return;
        }
        const res = await api.compareProviders({
          providers: compareTargets,
          prompt: trimmed,
          workspaceDir,
        });
        setSessions((prev) => [...res.sessions, ...prev]);
        setActiveCompareGroupId(res.groupId);
        setPrompt("");
        return;
      }

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
    mode,
    compareTargets,
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

  const toggleCompareTarget = useCallback((id: ExternalProviderId) => {
    setCompareTargets((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }, []);

  return (
    <div className="multi-ai-panel" data-testid="multi-ai-panel">
      <div className="multi-ai-top-bar">
        <div className="multi-ai-mode-tabs" role="tablist" aria-label="マルチAI表示切替">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "chat"}
            className={`multi-ai-mode-tab ${mode === "chat" ? "active" : ""}`}
            onClick={() => setMode("chat")}
          >
            💬 個別チャット
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "compare"}
            className={`multi-ai-mode-tab ${mode === "compare" ? "active" : ""}`}
            onClick={() => setMode("compare")}
            data-testid="multi-ai-compare-tab"
          >
            ⚖️ 並列比較
          </button>
        </div>

        <div className="multi-ai-provider-strip">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`multi-ai-chip ${
                mode === "chat" &&
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
                setMode("chat");
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

      {mode === "compare" ? (
        <div className="multi-ai-compare-wrap" data-testid="multi-ai-compare-view">
          <div className="multi-ai-compare-scroll">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                ⚖️ 複数AIへ同時質問・回答比較
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary, #94a3b8)",
                }}
              >
                比較したい AI を2つ以上選んで下の欄から送信すると、同時に回答を生成して並べて比較できます。
              </div>
              <div className="multi-ai-compare-targets">
                {(["openai", "anthropic", "ollama"] as ExternalProviderId[]).map(
                  (pid) => {
                    const info = providers.find((p) => p.id === pid);
                    const selected = compareTargets.includes(pid);
                    return (
                      <button
                        key={pid}
                        type="button"
                        aria-pressed={selected}
                        className={`multi-ai-compare-toggle ${selected ? "selected" : ""}`}
                        onClick={() => toggleCompareTarget(pid)}
                      >
                        <span>{selected ? "☑" : "☐"}</span>
                        <span>
                          {PROVIDER_ICONS[pid]} {PROVIDER_LABELS[pid]}
                        </span>
                        {info && (
                          <span style={{ fontSize: 10.5, opacity: 0.75 }}>
                            ({statusLabel(info.status)})
                          </span>
                        )}
                      </button>
                    );
                  },
                )}
              </div>
            </div>

            {compareGroups.length > 1 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {compareGroups.slice(0, 6).map((g) => (
                  <button
                    key={g.groupId}
                    type="button"
                    className={`multi-ai-preset-chip ${activeCompareGroup?.groupId === g.groupId ? "active" : ""}`}
                    style={
                      activeCompareGroup?.groupId === g.groupId
                        ? {
                            borderColor: "var(--accent, #60a5fa)",
                            background: "rgba(96, 165, 250, 0.18)",
                            color: "#f8fafc",
                          }
                        : undefined
                    }
                    onClick={() => setActiveCompareGroupId(g.groupId)}
                  >
                    {g.title}
                  </button>
                ))}
              </div>
            )}

            {activeCompareGroup ? (
              <>
                <div
                  style={{
                    padding: "9px 12px",
                    borderRadius: 10,
                    background: "rgba(96, 165, 250, 0.1)",
                    border: "1px solid rgba(96, 165, 250, 0.25)",
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  <strong>質問:</strong> {activeCompareGroup.prompt}
                </div>
                <div className="multi-ai-compare-grid">
                  {activeCompareGroup.items.map((item) => {
                    const assistantMsg = [...item.messages]
                      .reverse()
                      .find((m) => m.role === "assistant");
                    const elapsed = formatElapsed(assistantMsg?.elapsedMs);
                    return (
                      <div key={item.id} className="multi-ai-compare-card">
                        <div className="multi-ai-compare-card-head">
                          <span style={{ fontSize: 13, fontWeight: 700 }}>
                            {PROVIDER_ICONS[item.provider]}{" "}
                            {PROVIDER_LABELS[item.provider]}
                          </span>
                          <span
                            style={{
                              fontSize: 11,
                              color:
                                item.status === "running"
                                  ? "#60a5fa"
                                  : item.status === "error"
                                    ? "#f87171"
                                    : "#34d399",
                              fontWeight: 600,
                            }}
                          >
                            {item.status === "running"
                              ? "⚡ 応答中…"
                              : item.status === "error"
                                ? "⚠️ エラー"
                                : elapsed
                                  ? `✓ ${elapsed}`
                                  : "✓ 完了"}
                          </span>
                        </div>

                        <div className="multi-ai-compare-card-body">
                          {item.status === "running" && !assistantMsg ? (
                            <div className="typing-indicator">
                              <span />
                              <span />
                              <span />
                            </div>
                          ) : assistantMsg?.error ? (
                            <div className="multi-ai-msg error">
                              {assistantMsg.content}
                            </div>
                          ) : assistantMsg ? (
                            <div
                              className="multi-ai-msg-markdown"
                              dangerouslySetInnerHTML={{
                                __html: renderMarkdown(assistantMsg.content),
                              }}
                            />
                          ) : null}
                        </div>

                        <div className="multi-ai-compare-card-foot">
                          <div style={{ display: "flex", gap: 6 }}>
                            {assistantMsg && !assistantMsg.error && (
                              <button
                                type="button"
                                className="multi-ai-mini-btn"
                                onClick={() =>
                                  void handleCopyText(
                                    assistantMsg.id,
                                    assistantMsg.content,
                                  )
                                }
                              >
                                {copiedId === assistantMsg.id
                                  ? "✓ コピー済み"
                                  : "📋 コピー"}
                              </button>
                            )}
                            {item.status === "error" && (
                              <button
                                type="button"
                                className="multi-ai-mini-btn"
                                onClick={() => void handleRetry(item.id)}
                              >
                                ↻ 再試行
                              </button>
                            )}
                          </div>
                          <button
                            type="button"
                            className="multi-ai-mini-btn"
                            onClick={() => {
                              setMode("chat");
                              setSelectedSessionId(item.id);
                              setMobileChatOpen(true);
                            }}
                          >
                            💬 このAIで続ける →
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--text-tertiary, #94a3b8)",
                  padding: "16px 4px",
                }}
              >
                まだ並列比較の履歴はありません。下の入力欄（またはプリセットボタン）から質問を同時送信してみてください。
              </div>
            )}
          </div>

          <div className="multi-ai-composer">
            <div className="multi-ai-presets">
              {QUICK_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="multi-ai-preset-chip"
                  onClick={() =>
                    setPrompt((prev) => (prev ? `${p.prefix}${prev}` : p.prefix))
                  }
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="multi-ai-composer-row">
              <textarea
                className="multi-ai-textarea"
                rows={2}
                placeholder={`選択中の ${compareTargets.length} つのAIへ同時質問… (⌘Enter で実行)`}
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
                disabled={busy || !prompt.trim() || compareTargets.length < 2}
                onClick={() => void handleSend()}
                style={{ height: 42, padding: "0 14px", flexShrink: 0 }}
              >
                {busy ? "起動中…" : "⚖️ 同時比較"}
              </button>
            </div>
          </div>
        </div>
      ) : (
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
                  {selectedSession.messages.map((m) => {
                    const elapsed = formatElapsed(m.elapsedMs);
                    return (
                      <div
                        key={m.id}
                        className={`multi-ai-msg ${m.role} ${m.error ? "error" : ""}`}
                      >
                        {m.role === "assistant" && !m.error ? (
                          <div
                            className="multi-ai-msg-markdown"
                            dangerouslySetInnerHTML={{
                              __html: renderMarkdown(m.content),
                            }}
                          />
                        ) : (
                          m.content
                        )}
                        {m.role === "assistant" && (
                          <div className="multi-ai-msg-footer">
                            {elapsed && <span>応答 {elapsed}</span>}
                            <button
                              type="button"
                              className="multi-ai-mini-btn"
                              onClick={() => void handleCopyText(m.id, m.content)}
                            >
                              {copiedId === m.id ? "✓ コピー済み" : "📋 コピー"}
                            </button>
                            {m.error && (
                              <button
                                type="button"
                                className="multi-ai-mini-btn"
                                onClick={() =>
                                  void handleRetry(selectedSession.id)
                                }
                              >
                                ↻ 再試行
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
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
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 12 }}
                >
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
                    OpenAI（ChatGPT / Codex）・Anthropic（Claude Code）・ローカル Ollama を公式ログインのまま追加して対話できます。複数AIの回答を並べて見たい時は上の「⚖️ 並列比較」に切り替えてください。
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
                            <span
                              className={`provider-status-pill ${p.status}`}
                            >
                              {statusLabel(p.status)}
                            </span>
                          </div>
                          <div className="provider-card-desc">
                            {p.description}
                          </div>
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
                                  setComposerProvider(
                                    p.id as ExternalProviderId,
                                  );
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
              {!selectedSession && (
                <div className="multi-ai-presets">
                  {QUICK_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      className="multi-ai-preset-chip"
                      onClick={() =>
                        setPrompt((prev) =>
                          prev ? `${p.prefix}${prev}` : p.prefix,
                        )
                      }
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
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
                  disabled={
                    busy ||
                    !prompt.trim() ||
                    selectedSession?.status === "running"
                  }
                  onClick={() => void handleSend()}
                  style={{ height: 42, padding: "0 16px", flexShrink: 0 }}
                >
                  {busy || selectedSession?.status === "running"
                    ? "送信中…"
                    : "送信"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
