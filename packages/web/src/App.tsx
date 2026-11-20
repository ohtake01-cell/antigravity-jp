import { useState, useCallback, useEffect, useRef } from "react";
import {
  Routes,
  Route,
  useParams,
  useNavigate,
  Navigate,
  useLocation,
} from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { ChatHeader } from "./components/ChatHeader";
import { ChatPanel } from "./components/ChatPanel";
import { ChatInput } from "./components/ChatInput";
import { SettingsPanel } from "./components/SettingsPanel";
import { MultiAIPanel } from "./components/MultiAIPanel";
import { CommandPalette } from "./components/CommandPalette";
import { ArtifactWorkbench } from "./components/ArtifactWorkbench";
import { AgentMonitorPanel } from "./components/AgentMonitorPanel";
import { WorkspaceSelector } from "./components/WorkspaceSelector";
import { IconFolder } from "./components/Icons";
import { useConversations } from "./hooks/useConversations";
import { usePolling } from "./hooks/usePolling";
import { useWorkspaces, slugFromUri } from "./hooks/useWorkspaces";
import { useDraftText } from "./hooks/useDraftText";
import { useChatActions } from "./hooks/useChatActions";
import { useClientSettings, getAppIconUrl } from "./hooks/useClientSettings";
import { api } from "./api/client";
import { isUnconfirmedOptimisticMessage } from "./utils/optimisticMessages";
import type { NativeNotificationDeepLink } from "./utils/browserNotifications";
import type {
  AskQuestionEntry,
  ExternalProviderId,
  HealthResponse,
  MediaAttachment,
  ProviderId,
} from "./types";
import type { PlannerType } from "./components/ChatInput";

const LAST_CHAT_PATH_KEY = "antigravity-jp:lastChatPath";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/:projectSlug/settings" element={<ChatView />} />
      <Route path="/:projectSlug/multi-ai" element={<ChatView />} />
      <Route path="/:projectSlug" element={<ChatView />} />
      <Route path="/:projectSlug/:chatId" element={<ChatView />} />
    </Routes>
  );
}

// ── Root redirect: go to the first workspace's new-chat page ──

function RootRedirect() {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    let settled = false;
    const fallbackTimer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        setTarget("/unknown");
      }
    }, 4000);

    api
      .getWorkspaces()
      .then((data) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(fallbackTimer);
        const first = data.workspaceInfos?.[0];
        if (first) {
          setTarget(`/${slugFromUri(first.workspaceUri)}`);
        } else {
          setTarget("/unknown");
        }
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        window.clearTimeout(fallbackTimer);
        setTarget("/unknown");
      });

    return () => {
      window.clearTimeout(fallbackTimer);
    };
  }, []);

  if (target) return <Navigate to={target} replace />;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100dvh",
        gap: "12px",
        color: "var(--text-secondary, #9ca3af)",
        fontSize: "14px",
      }}
    >
      <div className="spinner" />
      <span>Antigravity 日本語版を読み込み中…</span>
    </div>
  );
}

// ── Main Chat View ──

function ChatView() {
  const { projectSlug, chatId } = useParams<{
    projectSlug: string;
    chatId: string;
  }>();
  const navigate = useNavigate();
  const location = useLocation();
  const isSettingsPage = location.pathname.endsWith("/settings");
  const isMultiAIPage = location.pathname.endsWith("/multi-ai");
  const activeId = chatId ?? null;
  const lastChatPathRef = useRef<string | null>(
    (() => {
      try {
        return sessionStorage.getItem(LAST_CHAT_PATH_KEY);
      } catch {
        return null;
      }
    })(),
  );
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 480);
  const isMobile = () => window.innerWidth <= 480;
  const {
    conversations,
    error: conversationsError,
    loading,
    refresh,
    optimisticRemove,
  } = useConversations(15_000);
  const {
    data: health,
    error: healthError,
    refresh: refreshHealth,
  } = usePolling<HealthResponse>(api.health, 30_000, true, 3_000);

  // ── Hooks ──
  const { workspaces, currentWorkspaceUri } = useWorkspaces(
    conversations,
    projectSlug,
  );
  const { draftText, handleDraftChange } = useDraftText(activeId);
  const { settings, updateSettings } = useClientSettings();
  const appTier = settings.appTier ?? "lite";
  const isProTier = appTier === "pro";

  // Command Palette (⌘K)
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Right-pane Artifact Workbench & Agent Monitor
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [workbenchFileRef, setWorkbenchFileRef] = useState<string | null>(null);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);

  // Multi-AI active session handoff (when branching or quick-dispatching in Pro mode)
  const [multiAISessionId, setMultiAISessionId] = useState<string | null>(null);

  // Quick Side Chat popover (Gemini-only in Lite mode; Multi-AI selector in Pro mode)
  const [sideChatOpen, setSideChatOpen] = useState(false);
  const [sideChatTarget, setSideChatTarget] = useState<{
    id: string;
    title: string;
    workspaceUri?: string;
  } | null>(null);
  const [sideChatProvider, setSideChatProvider] = useState<
    "antigravity" | ExternalProviderId
  >("antigravity");
  const [sideChatPrompt, setSideChatPrompt] = useState("");
  const [sideChatBusy, setSideChatBusy] = useState(false);

  useEffect(() => {
    const onDocClick = (ev: MouseEvent) => {
      if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
      const target = ev.target as HTMLElement | null;
      const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      const rawHref = anchor.getAttribute("href") ?? "";
      if (rawHref.startsWith("file://")) {
        ev.preventDefault();
        setWorkbenchFileRef(rawHref);
        setAgentPanelOpen(false);
        setWorkbenchOpen(true);
      }
    };
    const onOpenFileEvent = (ev: Event) => {
      const custom = ev as CustomEvent<{ fileRef?: string }>;
      const ref = custom.detail?.fileRef;
      if (ref) {
        setWorkbenchFileRef(ref);
      }
      setAgentPanelOpen(false);
      setWorkbenchOpen(true);
    };
    document.addEventListener("click", onDocClick);
    window.addEventListener("antigravity-jp-open-file", onOpenFileEvent);
    return () => {
      document.removeEventListener("click", onDocClick);
      window.removeEventListener("antigravity-jp-open-file", onOpenFileEvent);
    };
  }, []);

  // Remember the last chat route so toggling back from Settings / Multi-AI restores exact chat
  useEffect(() => {
    if (!isSettingsPage && !isMultiAIPage && location.pathname !== "/") {
      lastChatPathRef.current = location.pathname;
      try {
        sessionStorage.setItem(LAST_CHAT_PATH_KEY, location.pathname);
      } catch {
        // Ignore restricted storage
      }
    }
  }, [isMultiAIPage, isSettingsPage, location.pathname]);

  // Redirect away from /multi-ai if user switches back to Lite tier
  useEffect(() => {
    if (isMultiAIPage && !isProTier) {
      navigate(`/${projectSlug ?? "unknown"}`, { replace: true });
    }
  }, [isMultiAIPage, isProTier, navigate, projectSlug]);

  // Keep browser favicon synced
  useEffect(() => {
    const iconHref = getAppIconUrl(settings.appIconPreset);
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) {
      link.href = iconHref;
      link.type = "image/png";
    }
  }, [settings.appIconPreset]);

  const previousTargetApp = useRef(settings.targetApp);
  useEffect(() => {
    if (previousTargetApp.current === settings.targetApp) return;
    previousTargetApp.current = settings.targetApp;
    refresh();
    refreshHealth();
  }, [refresh, refreshHealth, settings.targetApp]);

  const activeConv = conversations.find((c) => c.id === activeId);
  const activeSubagentMatch =
    !activeConv && activeId
      ? (() => {
          for (const c of conversations) {
            const child = c.summary.subagents?.find((s) => s.id === activeId);
            if (child) return { parent: c, child };
          }
          return undefined;
        })()
      : undefined;
  const hasAliveLS = !!health && health.languageServers.length > 0;
  const connected = hasAliveLS || (!healthError && conversations.length > 0);
  const isRunning =
    connected &&
    !conversationsError &&
    (activeConv?.summary.status === "CASCADE_RUN_STATUS_RUNNING" ||
      activeSubagentMatch?.child.status === "CASCADE_RUN_STATUS_RUNNING");
  const activeContextParent = activeSubagentMatch?.parent ?? activeConv ?? null;
  const activeContextSubagents = activeContextParent?.summary.subagents ?? [];

  const {
    optimisticMessages,
    setOptimisticMessages,
    confirmOptimisticMessages,
    stepsRefreshKey,
    hardRefreshKey,
    pendingProject,
    clearPendingProject,
    handleSend: doSend,
    handleStartInProject,
    handleStop,
    handleRevert: rawHandleRevert,
    handleRemoveOptimistic: rawHandleRemoveOptimistic,
    handleDelete,
    chatUrl,
    triggerSoftRefresh,
  } = useChatActions({
    activeId,
    currentWorkspaceUri,
    projectSlug,
    refresh,
    conversations,
    optimisticRemove,
  });

  // Wire handleRevert to also update draft text
  const handleRevert = useCallback(
    async (stepIndex: number, draftContent?: string) => {
      const ok = await rawHandleRevert(stepIndex, draftContent);
      if (ok && draftContent) {
        handleDraftChange(draftContent);
      }
    },
    [rawHandleRevert, handleDraftChange],
  );

  // Remove a committed comment (reverts before that comment without restoring draft)
  const handleRemoveComment = useCallback(
    async (stepIndex: number) => {
      await rawHandleRevert(stepIndex);
    },
    [rawHandleRevert],
  );

  // Remove an unconfirmed/failed optimistic comment (optionally restoring its text to draft)
  const handleRemoveOptimistic = useCallback(
    (optimisticId: string, restoreDraft?: string) => {
      rawHandleRemoveOptimistic(optimisticId);
      if (restoreDraft) {
        handleDraftChange(restoreDraft);
      }
    },
    [rawHandleRemoveOptimistic, handleDraftChange],
  );

  // ── Send: always grant file access & forward Local Permissions policy ──
  const handleSend = useCallback(
    async (
      text: string,
      model: string | null,
      media?: MediaAttachment[],
      plannerType?: PlannerType,
    ) => {
      doSend(
        text,
        model,
        media,
        plannerType,
        true,
        settings.localPermissionPolicy ??
          "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER",
      );
    },
    [doSend, settings.localPermissionPolicy],
  );

  // Edit a user comment inline: revert before that comment (or remove local optimistic) and re-send
  const handleEditComment = useCallback(
    async (
      stepIndex: number,
      editedText: string,
      optimisticId?: string,
    ): Promise<boolean> => {
      const trimmed = editedText.trim();
      if (!trimmed) return false;
      const resolvedModel =
        activeConv?.summary.model ??
        activeSubagentMatch?.child.model ??
        settings.defaultModel ??
        null;

      if (optimisticId && stepIndex < 0) {
        rawHandleRemoveOptimistic(optimisticId);
        await handleSend(
          trimmed,
          resolvedModel,
          undefined,
          settings.defaultPlannerType,
        );
        return true;
      }

      const ok = await rawHandleRevert(stepIndex);
      if (!ok) return false;
      await handleSend(
        trimmed,
        resolvedModel,
        undefined,
        settings.defaultPlannerType,
      );
      return true;
    },
    [
      activeConv?.summary.model,
      activeSubagentMatch?.child.model,
      settings.defaultModel,
      settings.defaultPlannerType,
      rawHandleRemoveOptimistic,
      rawHandleRevert,
      handleSend,
    ],
  );

  // ── Per-file permission response ──
  const handleFilePermission = useCallback(
    async (
      trajectoryId: string,
      stepIndex: number,
      allow: boolean,
      scope: number,
      absolutePathUri: string,
    ) => {
      if (!activeId) return;
      try {
        await api.filePermission(
          activeId,
          trajectoryId,
          stepIndex,
          allow,
          scope,
          absolutePathUri,
        );
        triggerSoftRefresh();
        refresh();
      } catch (err) {
        console.error("Failed to respond to file permission:", err);
      }
    },
    [activeId, refresh, triggerSoftRefresh],
  );

  // ── Command action (approve/reject proposed command) ──
  const handleCommandAction = useCallback(
    async (trajectoryId: string, stepIndex: number, approved: boolean) => {
      if (!activeId) return;
      try {
        await api.commandAction(activeId, trajectoryId, stepIndex, approved);
        triggerSoftRefresh();
        refresh();
      } catch (err) {
        console.error("Failed to respond to command action:", err);
        throw err;
      }
    },
    [activeId, refresh, triggerSoftRefresh],
  );

  // ── Ask question response (Antigravity choice prompts) ──
  const handleAskQuestion = useCallback(
    async (
      trajectoryId: string,
      stepIndex: number,
      responses: AskQuestionEntry[],
      cancelled = false,
    ) => {
      if (!activeId) return;
      try {
        await api.askQuestion(
          activeId,
          trajectoryId,
          stepIndex,
          responses,
          cancelled,
        );
        triggerSoftRefresh();
        refresh();
      } catch (err) {
        console.error("Failed to respond to question:", err);
        throw err;
      }
    },
    [activeId, refresh, triggerSoftRefresh],
  );

  // ── Navigate helpers ──
  const handleNew = useCallback(() => {
    clearPendingProject();
    navigate(`/${projectSlug ?? "unknown"}`);
    setOptimisticMessages([]);
    if (isMobile()) setSidebarOpen(false);
  }, [clearPendingProject, navigate, projectSlug, setOptimisticMessages]);

  const handleOpenSettings = useCallback(() => {
    navigate(`/${projectSlug ?? "unknown"}/settings`);
    if (isMobile()) setSidebarOpen(false);
  }, [navigate, projectSlug]);

  const handleOpenMultiAI = useCallback(
    (sessionId?: string | null) => {
      if (sessionId !== undefined) {
        setMultiAISessionId(sessionId);
      }
      navigate(`/${projectSlug ?? "unknown"}/multi-ai`);
      if (isMobile()) setSidebarOpen(false);
    },
    [navigate, projectSlug],
  );

  useEffect(() => {
    const onOpenPalette = () => setPaletteOpen(true);
    const onNativeNewChat = () => handleNew();
    const onNativeOpenSettings = () => handleOpenSettings();
    const onNavigateDeepLink = (ev: Event) => {
      const detail = (ev as CustomEvent<NativeNotificationDeepLink>).detail;
      if (!detail) return;
      if (detail.kind === "chat" && detail.targetId) {
        setOptimisticMessages([]);
        navigate(`/${projectSlug ?? "unknown"}/${detail.targetId}`);
      }
    };
    const onGlobalKeyDown = (ev: KeyboardEvent) => {
      if (
        (ev.metaKey || ev.ctrlKey) &&
        !ev.altKey &&
        !ev.shiftKey &&
        ev.key.toLowerCase() === "k"
      ) {
        ev.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };

    window.addEventListener("antigravity-jp-open-palette", onOpenPalette);
    window.addEventListener("antigravity-jp:new-chat", onNativeNewChat);
    window.addEventListener(
      "antigravity-jp:open-settings",
      onNativeOpenSettings,
    );
    window.addEventListener("antigravity-jp-navigate", onNavigateDeepLink);
    window.addEventListener("keydown", onGlobalKeyDown);
    return () => {
      window.removeEventListener("antigravity-jp-open-palette", onOpenPalette);
      window.removeEventListener("antigravity-jp:new-chat", onNativeNewChat);
      window.removeEventListener(
        "antigravity-jp:open-settings",
        onNativeOpenSettings,
      );
      window.removeEventListener("antigravity-jp-navigate", onNavigateDeepLink);
      window.removeEventListener("keydown", onGlobalKeyDown);
    };
  }, [
    handleNew,
    handleOpenSettings,
    navigate,
    projectSlug,
    setOptimisticMessages,
  ]);

  const handleBackToChat = useCallback(() => {
    const saved = lastChatPathRef.current;
    if (saved && !saved.endsWith("/settings") && !saved.endsWith("/multi-ai")) {
      navigate(saved);
    } else {
      navigate(`/${projectSlug ?? "unknown"}`);
    }
    if (isMobile()) setSidebarOpen(false);
  }, [navigate, projectSlug]);

  // Helper: start a brand-new Gemini chat and send prompt directly
  const launchGeminiChatWithPrompt = useCallback(
    async (promptText: string, workspaceUri?: string, titleHint?: string) => {
      const { cascadeId } = await api.startConversation(
        workspaceUri ?? currentWorkspaceUri ?? undefined,
        true,
      );
      if (titleHint) {
        void api.renameConversation(cascadeId, titleHint).catch(() => {});
      }
      await api.sendMessage(
        cascadeId,
        [{ text: promptText }],
        undefined,
        settings.defaultModel ?? undefined,
        undefined,
        settings.defaultPlannerType,
        true,
        settings.localPermissionPolicy ??
          "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER",
      );
      refresh();
      setOptimisticMessages([]);
      navigate(chatUrl(cascadeId));
    },
    [
      chatUrl,
      currentWorkspaceUri,
      navigate,
      refresh,
      setOptimisticMessages,
      settings.defaultModel,
      settings.defaultPlannerType,
      settings.localPermissionPolicy,
    ],
  );

  // Header info
  const headerTitle = isSettingsPage
    ? "設定"
    : isMultiAIPage && isProTier
      ? "⚡ マルチAI"
      : activeId
        ? (activeConv?.summary.summary ??
          (activeSubagentMatch
            ? `🤖 ${activeSubagentMatch.child.role}`
            : "チャット"))
        : "新しいチャット";

  // ── Mobile Swipe Gestures ──
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!isMobile()) return;
      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;

      const dx = touchEndX - touchStartX.current;
      const dy = touchEndY - touchStartY.current;

      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
        if (dx > 0 && touchStartX.current < 30) {
          setSidebarOpen(true);
        } else if (dx < 0 && sidebarOpen) {
          setSidebarOpen(false);
        }
      }
    },
    [sidebarOpen],
  );

  return (
    <div
      className="app-layout"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={(id) => {
          clearPendingProject();
          setOptimisticMessages([]);
          navigate(chatUrl(id));
          if (isMobile()) setSidebarOpen(false);
        }}
        onNew={handleNew}
        onNewInProject={(project) => {
          handleStartInProject(project);
          if (isMobile()) setSidebarOpen(false);
        }}
        onBranchSideChat={(conv) => {
          setSideChatTarget({
            id: conv.id,
            title: conv.summary.summary || "チャット",
            workspaceUri:
              conv.summary.workspaces?.[0]?.workspaceFolderAbsoluteUri ??
              currentWorkspaceUri ??
              undefined,
          });
          setSideChatOpen(true);
          if (isMobile()) setSidebarOpen(false);
        }}
        onOpenAgentPanel={(convId) => {
          if (convId !== activeId) {
            setOptimisticMessages([]);
            navigate(chatUrl(convId));
          }
          setWorkbenchOpen(false);
          setAgentPanelOpen(true);
          if (isMobile()) setSidebarOpen(false);
        }}
        onDelete={handleDelete}
        onRefresh={refresh}
        onSettings={handleOpenSettings}
        appTier={appTier}
        onMultiAI={() => handleOpenMultiAI()}
        isMultiAI={isMultiAIPage}
        appIconPreset={settings.appIconPreset}
        loading={loading}
        connected={connected}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen((v) => !v)}
      />
      {/* Mobile backdrop: tap to close sidebar */}
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <div className="main-panel">
        <ChatHeader
          title={headerTitle}
          projectName={projectSlug ?? undefined}
          modelLabel={
            !isSettingsPage && !isMultiAIPage
              ? (activeConv?.summary.modelLabel ??
                activeSubagentMatch?.child.modelLabel)
              : undefined
          }
          modelProvider={
            !isSettingsPage && !isMultiAIPage
              ? (activeConv?.summary.modelProvider ??
                activeSubagentMatch?.child.modelProvider)
              : undefined
          }
          targetApp={settings.targetApp}
          onTargetAppChange={(app) => updateSettings({ targetApp: app })}
          onMenuToggle={() => setSidebarOpen(true)}
          isRunning={!isSettingsPage && !isMultiAIPage && isRunning}
          workbenchOpen={workbenchOpen}
          onToggleWorkbench={() => {
            setWorkbenchOpen((v) => {
              const next = !v;
              if (next) setAgentPanelOpen(false);
              return next;
            });
          }}
          onOpenPalette={() => setPaletteOpen(true)}
        />
        {!isSettingsPage &&
          !isMultiAIPage &&
          activeId &&
          (activeSubagentMatch || activeContextSubagents.length > 0) && (
            <div
              className={`subagent-context-bar ${activeSubagentMatch ? "is-child" : ""}`}
              data-testid="subagent-context-bar"
            >
              {activeSubagentMatch ? (
                <button
                  type="button"
                  className="subagent-context-back-btn"
                  onClick={() => {
                    setOptimisticMessages([]);
                    navigate(chatUrl(activeSubagentMatch.parent.id));
                  }}
                  title={`親チャット「${activeSubagentMatch.parent.summary.summary}」に戻る`}
                >
                  ← 親: {activeSubagentMatch.parent.summary.summary}
                </button>
              ) : (
                <span className="subagent-context-label">
                  🤖 エージェント ({activeContextSubagents.length})
                </span>
              )}
              <div className="subagent-context-chips" role="list">
                {activeContextSubagents.map((child) => {
                  const isCurrentChild = child.id === activeId;
                  const childRunning =
                    child.status === "CASCADE_RUN_STATUS_RUNNING";
                  return (
                    <button
                      key={child.id}
                      type="button"
                      role="listitem"
                      className={`subagent-context-chip ${isCurrentChild ? "active" : ""} ${childRunning ? "running" : ""}`}
                      onClick={() => {
                        if (isCurrentChild) return;
                        setOptimisticMessages([]);
                        navigate(chatUrl(child.id));
                      }}
                      title={`${child.role} (${child.typeName})${child.modelLabel ? ` · ${child.modelLabel}` : ""}`}
                    >
                      <span
                        className={`subagent-context-dot ${childRunning ? "running" : ""}`}
                        aria-hidden="true"
                      />
                      <span className="subagent-context-chip-role">
                        {child.role}
                      </span>
                      {child.typeName && child.typeName !== "subagent" && (
                        <span className="subagent-context-chip-type">
                          {child.typeName}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="subagent-context-detail-btn"
                onClick={() => {
                  setAgentPanelOpen((v) => {
                    const next = !v;
                    if (next) setWorkbenchOpen(false);
                    return next;
                  });
                }}
                title="サブエージェント・バックグラウンドタスクの詳細パネルを開く"
              >
                🤖 エージェント詳細
              </button>
            </div>
          )}
        {sideChatOpen &&
          (sideChatTarget || activeId) &&
          (() => {
            const branchSource = sideChatTarget ?? {
              id: activeId!,
              title: headerTitle,
              workspaceUri: currentWorkspaceUri ?? undefined,
            };
            return (
              <div
                className="sidechat-popover"
                role="dialog"
                aria-label="枝分かれサイドチャット作成"
              >
                <div className="sidechat-popover-title">
                  🌿 本流を汚さずに枝分かれ検証
                </div>
                <div className="sidechat-popover-hint">
                  チャット「{branchSource.title}
                  」から分岐し、本流の記憶や文脈を汚さずに
                  {isProTier ? "別チャットや他社AI" : "別チャット（Gemini）"}
                  で仮説検証を行います。
                </div>
                {isProTier && (
                  <select
                    className="wb-path-input"
                    aria-label="枝分かれ先のAI"
                    value={sideChatProvider}
                    onChange={(e) =>
                      setSideChatProvider(
                        e.target.value as "antigravity" | ExternalProviderId,
                      )
                    }
                  >
                    <option value="antigravity">✨ Gemini（別チャットで開く）</option>
                    <option value="openai">🟢 OpenAI / ChatGPT (Codex)</option>
                    <option value="anthropic">🟣 Anthropic / Claude</option>
                    <option value="ollama">🌱 ローカル AI (Ollama)</option>
                  </select>
                )}
                <textarea
                  className="wb-path-input"
                  aria-label="枝分かれで試したい質問"
                  rows={3}
                  placeholder="例：別案Bで設計した場合のメリット・デメリットだけ先に教えて"
                  value={sideChatPrompt}
                  onChange={(e) => setSideChatPrompt(e.target.value)}
                />
                <div
                  style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}
                >
                  <button
                    type="button"
                    className="wb-open-btn secondary"
                    onClick={() => {
                      setSideChatOpen(false);
                      setSideChatTarget(null);
                    }}
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    className="wb-open-btn"
                    disabled={sideChatBusy || !sideChatPrompt.trim()}
                    onClick={async () => {
                      setSideChatBusy(true);
                      try {
                        const rawPrompt = sideChatPrompt.trim();
                        const composed = `【枝分かれ検証】元チャット「${branchSource.title}」から分岐:\n\n${rawPrompt}`;
                        const shortTitle = `🌿 ${branchSource.title.slice(0, 18)} (分岐)`;
                        const effectiveProvider = isProTier
                          ? sideChatProvider
                          : "antigravity";
                        if (effectiveProvider === "antigravity") {
                          await launchGeminiChatWithPrompt(
                            composed,
                            branchSource.workspaceUri,
                            shortTitle,
                          );
                        } else {
                          const wsUri =
                            branchSource.workspaceUri ?? currentWorkspaceUri;
                          const workspaceDir = wsUri?.startsWith("file://")
                            ? decodeURIComponent(new URL(wsUri).pathname)
                            : undefined;
                          const res = await api.createProviderSession({
                            provider: effectiveProvider,
                            prompt: composed,
                            title: shortTitle,
                            workspaceDir,
                            sourceChatId: branchSource.id,
                            sourceChatTitle: branchSource.title,
                          });
                          handleOpenMultiAI(res.session.id);
                        }
                        setSideChatOpen(false);
                        setSideChatTarget(null);
                        setSideChatPrompt("");
                      } catch (err) {
                        console.error("Failed to create side chat:", err);
                      } finally {
                        setSideChatBusy(false);
                      }
                    }}
                  >
                    {sideChatBusy ? "起動中…" : "🌿 枝分かれ起動"}
                  </button>
                </div>
              </div>
            );
          })()}
        {isSettingsPage ? (
          <SettingsPanel
            settings={settings}
            onUpdate={updateSettings}
            onBack={handleBackToChat}
            onRefreshConversations={refresh}
            onOpenRestoredChat={(id, summary) => {
              const uri = summary.workspaces?.[0]?.workspaceFolderAbsoluteUri;
              const slug = uri ? slugFromUri(uri) : (projectSlug ?? "unknown");
              setOptimisticMessages([]);
              navigate(`/${slug}/${id}`);
            }}
          />
        ) : isMultiAIPage && isProTier ? (
          <MultiAIPanel
            currentWorkspaceUri={currentWorkspaceUri}
            initialSessionId={multiAISessionId}
            onBackToGemini={handleBackToChat}
            onOpenSettings={handleOpenSettings}
          />
        ) : activeId ? (
          <ChatPanel
            key={`${activeId}:${settings.targetApp}`}
            cascadeId={activeId}
            targetApp={settings.targetApp}
            onRevert={handleRevert}
            onEditComment={handleEditComment}
            onRemoveComment={handleRemoveComment}
            onRemoveOptimistic={handleRemoveOptimistic}
            onFilePermission={handleFilePermission}
            onCommandAction={handleCommandAction}
            onAskQuestion={handleAskQuestion}
            onConfirmOptimistic={confirmOptimisticMessages}
            optimisticMessages={optimisticMessages}
            refreshKey={stepsRefreshKey}
            hardRefreshKey={hardRefreshKey}
            totalStepCount={
              activeConv?.summary.stepCount ??
              activeSubagentMatch?.child.stepCount
            }
            isConversationRunning={isRunning}
            browserNotificationsEnabled={settings.browserNotificationsEnabled}
            conversationTitle={headerTitle}
            childSubagents={activeContextSubagents}
            onSidebarRefresh={refresh}
            onOpenConversation={(id) => {
              setOptimisticMessages([]);
              navigate(chatUrl(id));
              if (isMobile()) setSidebarOpen(false);
            }}
          />
        ) : (
          <div
            className="chat-area"
            onTouchMove={() => {
              const el = document.activeElement;
              if (
                el instanceof HTMLTextAreaElement ||
                el instanceof HTMLInputElement
              ) {
                el.blur();
              }
            }}
          >
            <div className="chat-area-inner">
              {optimisticMessages.map((msg, i) => (
                <div
                  key={msg.optimisticId ?? i}
                  className={`message ${msg.role}${isUnconfirmedOptimisticMessage(msg) ? " unconfirmed" : ""}`}
                >
                  <div className="chat-block message-body">
                    <p>{msg.content}</p>
                  </div>
                </div>
              ))}
              {optimisticMessages.some(isUnconfirmedOptimisticMessage) && (
                <div className="message assistant">
                  <div className="chat-block message-body">
                    <div className="typing-indicator">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                </div>
              )}
            </div>
            {optimisticMessages.length === 0 && (
              <div className="chat-empty">
                <div className="chat-empty-icon">
                  <svg
                    width="48"
                    height="48"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <defs>
                      <linearGradient
                        id="chatGrad"
                        x1="0%"
                        y1="0%"
                        x2="100%"
                        y2="100%"
                      >
                        <stop offset="0%" stopColor="var(--accent)" />
                        <stop offset="50%" stopColor="#a78bfa" />
                        <stop offset="100%" stopColor="#f472b6" />
                      </linearGradient>
                    </defs>
                    <path
                      d="M12 2C6.48 2 2 5.92 2 10.67c0 2.72 1.47 5.15 3.78 6.73L4.5 21.5l4.33-2.17c1.02.28 2.09.43 3.17.43 5.52 0 10-3.92 10-8.76S17.52 2 12 2z"
                      fill="url(#chatGrad)"
                      opacity="0.25"
                    />
                    <path
                      d="M12 2C6.48 2 2 5.92 2 10.67c0 2.72 1.47 5.15 3.78 6.73L4.5 21.5l4.33-2.17c1.02.28 2.09.43 3.17.43 5.52 0 10-3.92 10-8.76S17.52 2 12 2z"
                      stroke="url(#chatGrad)"
                      strokeWidth="1.5"
                      fill="none"
                    />
                  </svg>
                </div>
                <div className="chat-empty-text">会話を始めましょう</div>
                {pendingProject ? (
                  <div
                    className="chat-empty-project"
                    title={pendingProject.folderPath ?? pendingProject.name}
                  >
                    <IconFolder size={13} /> {pendingProject.name} で新規チャット
                  </div>
                ) : workspaces.length > 0 && currentWorkspaceUri ? (
                  <WorkspaceSelector
                    workspaces={workspaces}
                    selected={currentWorkspaceUri}
                    onSelect={(uri) => {
                      const slug = slugFromUri(uri);
                      navigate(`/${slug}`);
                    }}
                  />
                ) : (
                  <div className="chat-empty-project">
                    <IconFolder size={13} />{" "}
                    {projectSlug ?? "ワークスペースなし"}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {!isSettingsPage && !isMultiAIPage && !connected && (
          <div className="connection-retry-banner" role="status">
            <span>⚠️ サーバー接続を確認しています…（自動再接続中）</span>
            <button
              type="button"
              className="connection-retry-btn"
              onClick={() => {
                refreshHealth();
                refresh();
              }}
            >
              今すぐ再接続
            </button>
          </div>
        )}
        {!isSettingsPage && !isMultiAIPage && (
          <ChatInput
            onSend={handleSend}
            onStop={handleStop}
            isRunning={isRunning}
            disabled={!connected}
            draft={draftText}
            onDraftChange={handleDraftChange}
            conversationId={activeId}
            conversationModel={
              activeConv?.summary.model ??
              activeSubagentMatch?.child.model ??
              null
            }
            defaultModel={settings.defaultModel}
            onAutoHealDefaultModel={(healed) => {
              if (settings.defaultModel && settings.defaultModel !== healed) {
                updateSettings({ defaultModel: healed });
              }
            }}
            defaultPlannerType={settings.defaultPlannerType}
            permissionPolicy={
              settings.localPermissionPolicy ??
              "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER"
            }
            onPermissionPolicyChange={(localPermissionPolicy) => {
              updateSettings({ localPermissionPolicy });
            }}
            appTier={appTier}
          />
        )}
      </div>
      <ArtifactWorkbench
        isOpen={workbenchOpen}
        initialFileRef={workbenchFileRef}
        currentWorkspaceUri={currentWorkspaceUri}
        onClose={() => setWorkbenchOpen(false)}
      />
      <AgentMonitorPanel
        isOpen={agentPanelOpen && !isSettingsPage && !isMultiAIPage}
        conversationId={activeContextParent?.id ?? activeId}
        activeId={activeId}
        onClose={() => setAgentPanelOpen(false)}
        onOpenConversation={(id) => {
          setOptimisticMessages([]);
          navigate(chatUrl(id));
          if (isMobile()) setSidebarOpen(false);
        }}
      />
      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        conversations={conversations}
        canBranchSideChat={Boolean(!isSettingsPage && !isMultiAIPage && activeId)}
        workbenchOpen={workbenchOpen}
        onNewChat={handleNew}
        onSelectChat={(id) => {
          setOptimisticMessages([]);
          navigate(chatUrl(id));
          if (isMobile()) setSidebarOpen(false);
        }}
        onOpenSettings={handleOpenSettings}
        onToggleWorkbench={() => setWorkbenchOpen((v) => !v)}
        onOpenFileInWorkbench={(filePath) => {
          setWorkbenchFileRef(filePath);
          setWorkbenchOpen(true);
        }}
        onOpenSideChat={() => {
          setSideChatTarget(null);
          setSideChatOpen(true);
        }}
        onTriggerVoice={() => {
          window.dispatchEvent(
            new CustomEvent("antigravity-jp-voice-trigger"),
          );
        }}
        appTier={appTier}
        onOpenMultiAI={() => handleOpenMultiAI()}
        onQuickDispatch={async (provider: ProviderId, promptText: string) => {
          if (provider === "antigravity" || !isProTier) {
            await launchGeminiChatWithPrompt(promptText);
            return;
          }
          const extProvider: ExternalProviderId =
            provider === "codex"
              ? "openai"
              : provider === "claude"
                ? "anthropic"
                : "ollama";
          const workspaceDir = currentWorkspaceUri?.startsWith("file://")
            ? decodeURIComponent(new URL(currentWorkspaceUri).pathname)
            : undefined;
          const res = await api.createProviderSession({
            provider: extProvider,
            prompt: promptText,
            workspaceDir,
          });
          handleOpenMultiAI(res.session.id);
        }}
      />
    </div>
  );
}
