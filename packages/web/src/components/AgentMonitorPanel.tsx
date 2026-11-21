import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type {
  BackgroundTaskLogItem,
  ConversationAgentItem,
  ConversationAgentsResponse,
} from "../types";

interface Props {
  isOpen: boolean;
  conversationId: string | null;
  activeId?: string | null;
  onClose: () => void;
  onOpenConversation: (id: string) => void;
}

type MonitorTab = "all" | "agents" | "tasks";

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "たった今";
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}秒前`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getAgentStatePresentation(agent: ConversationAgentItem): {
  label: string;
  tone: "running" | "alive" | "done";
} {
  if (agent.running || agent.status === "CASCADE_RUN_STATUS_RUNNING") {
    return { label: "実行中", tone: "running" };
  }
  if (agent.state === "SUBAGENT_STATE_ALIVE") {
    return { label: "待機・生存", tone: "alive" };
  }
  if (agent.state === "SUBAGENT_STATE_KILLED") {
    return { label: "終了", tone: "done" };
  }
  return { label: "完了", tone: "done" };
}

export function AgentMonitorPanel({
  isOpen,
  conversationId,
  activeId,
  onClose,
  onOpenConversation,
}: Props) {
  const [data, setData] = useState<ConversationAgentsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<MonitorTab>("all");
  const [expandedTaskIds, setExpandedTaskIds] = useState<
    Record<string, boolean>
  >({});

  const fetchAgents = useCallback(
    async (silent = false) => {
      if (!conversationId) {
        setData(null);
        setError(null);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const res = await api.conversationAgents(conversationId);
        setData(res);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "エージェント情報の取得に失敗しました",
        );
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [conversationId],
  );

  useEffect(() => {
    if (!isOpen || !conversationId) return;
    void fetchAgents(false);
    const timer = window.setInterval(() => {
      void fetchAgents(true);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [isOpen, conversationId, fetchAgents]);

  if (!isOpen) return null;

  const subagents = Array.isArray(data?.subagents) ? data.subagents : [];
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const runningSubagents = data?.counts?.runningSubagents ?? 0;
  const activeTasks = data?.counts?.activeTasks ?? 0;

  const showAgents = tab === "all" || tab === "agents";
  const showTasks = tab === "all" || tab === "tasks";

  const toggleTaskExpand = (task: BackgroundTaskLogItem) => {
    setExpandedTaskIds((prev) => ({ ...prev, [task.id]: !prev[task.id] }));
  };

  return (
    <aside
      className="wb-pane agent-monitor-pane"
      aria-label="エージェント・バックグラウンドタスク可視化パネル"
      data-testid="agent-monitor-panel"
    >
      <div className="wb-header agent-monitor-header">
        <div className="wb-header-title-row">
          <span className="wb-kind-badge agent-monitor-badge">🤖 エージェント</span>
          <span className="wb-doc-name">エージェント & タスク状況</span>
          {(runningSubagents > 0 || activeTasks > 0) && (
            <span className="agent-monitor-live-pill">
              <span className="agent-status-dot running" aria-hidden="true" />
              稼働 {runningSubagents + activeTasks}
            </span>
          )}
        </div>
        <div className="wb-header-actions">
          <button
            type="button"
            className="wb-open-btn secondary"
            onClick={() => void fetchAgents(false)}
            disabled={loading || !conversationId}
            title="最新状況を再取得"
          >
            {loading ? "更新中…" : "↻ 更新"}
          </button>
          <button
            type="button"
            className="wb-close-btn"
            onClick={onClose}
            aria-label="エージェントパネルを閉じる"
            title="閉じる"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="agent-monitor-toolbar">
        <div className="wb-mode-tabs" role="tablist" aria-label="表示フィルタ">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "all"}
            className={`wb-mode-btn ${tab === "all" ? "active" : ""}`}
            onClick={() => setTab("all")}
          >
            すべて ({subagents.length + tasks.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "agents"}
            className={`wb-mode-btn ${tab === "agents" ? "active" : ""}`}
            onClick={() => setTab("agents")}
          >
            サブエージェント ({subagents.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "tasks"}
            className={`wb-mode-btn ${tab === "tasks" ? "active" : ""}`}
            onClick={() => setTab("tasks")}
          >
            タスク ({tasks.length})
          </button>
        </div>
      </div>

      {error && (
        <div className="wb-error" role="alert">
          {error}
        </div>
      )}

      <div className="wb-body agent-monitor-body">
        {!conversationId ? (
          <div className="wb-empty">
            チャットを選択すると、この会話で起動されたサブエージェントやバックグラウンドタスクを可視化します。
          </div>
        ) : loading && !data ? (
          <div className="wb-empty">エージェント・タスク情報を読み込み中…</div>
        ) : (
          <div className="agent-monitor-scroll">
            {showAgents && (
              <section
                className="agent-monitor-section"
                aria-label="サブエージェント一覧"
              >
                <div className="agent-monitor-section-head">
                  <span>🤖 サブエージェント ({subagents.length})</span>
                  {runningSubagents > 0 && (
                    <span className="agent-monitor-running-count">
                      実行中 {runningSubagents}
                    </span>
                  )}
                </div>

                {subagents.length === 0 ? (
                  <div className="agent-monitor-empty-card">
                    この会話で起動されたサブエージェントはまだありません。
                  </div>
                ) : (
                  <div className="agent-monitor-cards">
                    {subagents.map((agent) => {
                      const stateInfo = getAgentStatePresentation(agent);
                      const isCurrent = agent.id === activeId;
                      return (
                        <div
                          key={agent.id}
                          className={`agent-monitor-card ${stateInfo.tone} ${isCurrent ? "current" : ""}`}
                          data-testid="agent-monitor-agent-card"
                        >
                          <div className="agent-monitor-card-top">
                            <span
                              className={`agent-status-dot ${stateInfo.tone}`}
                              aria-hidden="true"
                            />
                            <span className="agent-monitor-role" title={agent.role}>
                              {agent.role}
                            </span>
                            <span className="agent-monitor-type-badge">
                              {agent.typeName}
                            </span>
                            <span
                              className={`agent-monitor-state-pill ${stateInfo.tone}`}
                            >
                              {stateInfo.label}
                            </span>
                          </div>
                          <div className="agent-monitor-card-meta">
                            <span>ID: {agent.id.slice(0, 8)}</span>
                            {typeof agent.stepCount === "number" && (
                              <span>{agent.stepCount} ステップ</span>
                            )}
                            {typeof agent.spawnStepIndex === "number" && (
                              <span>起動位置 #{agent.spawnStepIndex}</span>
                            )}
                            <span>{formatRelativeTime(agent.lastModifiedTime)}</span>
                          </div>
                          <div className="agent-monitor-card-actions">
                            <button
                              type="button"
                              className="agent-monitor-open-btn"
                              onClick={() => onOpenConversation(agent.id)}
                              disabled={isCurrent}
                            >
                              {isCurrent ? "現在表示中" : "チャットを開く →"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {showTasks && (
              <section
                className="agent-monitor-section"
                aria-label="バックグラウンドタスク一覧"
              >
                <div className="agent-monitor-section-head">
                  <span>⚙️ バックグラウンドタスク ({tasks.length})</span>
                  {activeTasks > 0 && (
                    <span className="agent-monitor-running-count">
                      実行中 {activeTasks}
                    </span>
                  )}
                </div>

                {tasks.length === 0 ? (
                  <div className="agent-monitor-empty-card">
                    バックグラウンドタスクログはまだありません。
                  </div>
                ) : (
                  <div className="agent-monitor-cards">
                    {tasks.map((task) => {
                      const isExpanded = Boolean(expandedTaskIds[task.id]);
                      return (
                        <div
                          key={task.id}
                          className={`agent-monitor-card ${task.isActive ? "running" : "done"}`}
                          data-testid="agent-monitor-task-card"
                        >
                          <button
                            type="button"
                            className="agent-monitor-task-toggle"
                            aria-expanded={isExpanded}
                            onClick={() => toggleTaskExpand(task)}
                          >
                            <div className="agent-monitor-card-top">
                              <span
                                className={`agent-status-dot ${task.isActive ? "running" : "done"}`}
                                aria-hidden="true"
                              />
                              <span className="agent-monitor-task-id">
                                {task.id}
                              </span>
                              <span
                                className={`agent-monitor-state-pill ${task.isActive ? "running" : "done"}`}
                              >
                                {task.isActive ? "実行中" : "完了"}
                              </span>
                              <span className="agent-monitor-caret">
                                {isExpanded ? "▴" : "▾"}
                              </span>
                            </div>
                            <div className="agent-monitor-card-meta">
                              <span>{formatBytes(task.sizeBytes)}</span>
                              <span>{formatRelativeTime(task.updatedAt)}</span>
                              <span>{task.fileName}</span>
                            </div>
                          </button>
                          {isExpanded && (
                            <pre
                              className="agent-monitor-task-log"
                              data-testid="agent-monitor-task-log"
                            >
                              {task.tailPreview || "（出力なし）"}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
