import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
} from "react";
import { createPortal } from "react-dom";

import { useChatNotifications } from "../hooks/useChatNotifications";
import { useStepsStream } from "../hooks/useStepsStream";
import { stepsToMessages } from "../transforms/stepsToMessages";
import {
  isUnconfirmedOptimisticMessage,
  mergeOptimisticMessages,
} from "../utils/optimisticMessages";
import { renderMarkdown } from "../utils/markdown";
import { MarkdownContent } from "./MarkdownContent";
import {
  AskQuestionCard,
  CommandCard,
  CodeActionCard,
  FilePermissionCard,
  PermissionCard,
  SubagentCard,
} from "./StepCards";
import { getAskQuestionRequest, getFilePermissionRequest, getPermissionRequest } from "../utils/stepCards";
import {
  IconCopy,
  IconCheck,
  IconUndo,
  IconPencil,
  IconTrash,
  IconX,
  IconSearch,
  IconFile,
  IconFileSearch,
  IconFolder,
  IconList,
  IconEye,
  IconMessageCircle,
  IconAlertTriangle,
  IconChevron,
} from "./Icons";
import type {
  AskQuestionEntry,
  ChatMessage,
  SubagentChildSummary,
  TargetApp,
} from "../types";

interface Props {
  cascadeId: string;
  targetApp?: TargetApp;
  onRevert: (stepIndex: number, editText?: string) => void;
  onEditComment?: (
    stepIndex: number,
    editedText: string,
    optimisticId?: string,
  ) => Promise<boolean> | void;
  onRemoveComment?: (stepIndex: number) => void;
  onRemoveOptimistic?: (optimisticId: string, restoreDraft?: string) => void;
  onFilePermission: (
    trajectoryId: string,
    stepIndex: number,
    allow: boolean,
    scope: number,
    absolutePathUri: string,
  ) => void;
  onCommandAction?: (
    trajectoryId: string,
    stepIndex: number,
    approved: boolean,
  ) => Promise<void>;
  onAskQuestion?: (
    trajectoryId: string,
    stepIndex: number,
    responses: AskQuestionEntry[],
    cancelled?: boolean,
  ) => Promise<void>;
  onConfirmOptimistic?: (ids: string[]) => void;
  optimisticMessages?: ChatMessage[];
  refreshKey?: number;
  hardRefreshKey?: number;
  totalStepCount?: number;
  isConversationRunning?: boolean;
  browserNotificationsEnabled?: boolean;
  conversationTitle?: string;
  /** Child subagent list attached to this parent conversation (for fallback link resolution). */
  childSubagents?: SubagentChildSummary[];
  /** Called when the WS reports the agent went idle — triggers sidebar refresh. */
  onSidebarRefresh?: () => void;
  /** Called when clicking a child subagent link inside the chat timeline. */
  onOpenConversation?: (conversationId: string) => void;
}

/** Compact single-line collapsible thinking block (no bulky card/tab frame) */
function ImplementationPlanBlock({
  plan,
  duration,
  live = false,
}: {
  plan: string;
  duration?: string;
  live?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const renderedPlan = useMemo(() => renderMarkdown(plan), [plan]);
  let durationLabel = "";
  if (duration) {
    const match = duration.match(/([\d.]+)s/);
    if (match) {
      durationLabel = `${parseFloat(match[1]).toFixed(1)}s`;
    }
  }

  return (
    <details
      className={`implementation-plan-block${live ? " live" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="implementation-plan-header">
        <span className="implementation-plan-chevron" aria-hidden="true">
          <IconChevron size={11} />
        </span>
        {live && <span className="implementation-plan-live-dot" aria-hidden="true" />}
        <span className="implementation-plan-label">
          {live ? "思考中..." : "思考プロセス"}
        </span>
        {durationLabel && (
          <span className="implementation-plan-meta">{durationLabel}</span>
        )}
      </summary>
      <div className="implementation-plan-content">
        <MarkdownContent html={renderedPlan} />
        <div className="implementation-plan-actions">
          <button
            className="msg-action-btn implementation-plan-copy"
            title="思考プロセスをコピー"
            onClick={() => {
              navigator.clipboard.writeText(plan).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </button>
        </div>
      </div>
    </details>
  );
}

function textFromStepItems(items?: { text?: string }[]): string {
  if (!items) return "";
  return items
    .filter((item) => item.text?.trim())
    .map((item) => item.text!.trim())
    .join("\n\n");
}

function implementationPlanFromStep(step: ChatMessage["step"]): string {
  const plannerResponse = step?.plannerResponse;
  if (!plannerResponse) return "";

  const thinking = plannerResponse.thinking?.trim();
  if (thinking) return plannerResponse.thinking ?? "";

  const itemText = textFromStepItems(plannerResponse.items);
  if (!plannerResponse.modifiedResponse?.trim() && itemText) return itemText;

  return "";
}

interface LiveImplementationPlan {
  plan: string;
  duration?: string;
  stepIndex: number;
}

function latestImplementationPlan(
  steps: ChatMessage["step"][],
  baseOffset = 0,
): LiveImplementationPlan | null {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    const plan = implementationPlanFromStep(step);
    if (plan.trim()) {
      return {
        plan,
        duration: step?.plannerResponse?.thinkingDuration,
        stepIndex: baseOffset + index,
      };
    }
  }

  return null;
}

/** Map icon key → Lucide component */
function MsgIcon({ name }: { name?: string }) {
  if (!name) return null;
  const s = 12;
  switch (name) {
    case "search":
      return <IconSearch size={s} />;
    case "eye":
      return <IconEye size={s} />;
    case "file":
      return <IconFile size={s} />;
    case "file-search":
      return <IconFileSearch size={s} />;
    case "folder":
      return <IconFolder size={s} />;
    case "list":
      return <IconList size={s} />;
    case "alert":
      return <IconAlertTriangle size={s} />;
    default:
      return null;
  }
}

function PinnedImplementationPlanMessage({
  implementationPlan,
  live,
}: {
  implementationPlan: LiveImplementationPlan;
  live: boolean;
}) {
  return (
    <div className="message assistant pinned-implementation-plan-message thinking-only-message">
      <div
        className={`thinking-only-body pinned-implementation-plan-body${
          live ? " live" : ""
        }`}
      >
        <ImplementationPlanBlock
          plan={implementationPlan.plan}
          duration={implementationPlan.duration}
          live={live}
        />
      </div>
    </div>
  );
}

function isErrorStepMessage(msg: ChatMessage): boolean {
  return (
    msg.type === "error" ||
    msg.type === "CORTEX_STEP_TYPE_ERROR_MESSAGE" ||
    msg.icon === "alert"
  );
}

const SystemMessage = memo(function SystemMessage({
  msg,
  cascadeId,
  onFilePermission,
  onCommandAction,
  onAskQuestion,
  onOpenConversation,
  onRemoveOptimistic,
  childSubagents,
}: {
  msg: ChatMessage;
  cascadeId?: string;
  onFilePermission: (
    trajectoryId: string,
    stepIndex: number,
    allow: boolean,
    scope: number,
    absolutePathUri: string,
  ) => void;
  onCommandAction?: (
    trajectoryId: string,
    stepIndex: number,
    approved: boolean,
  ) => Promise<void>;
  onAskQuestion?: (
    trajectoryId: string,
    stepIndex: number,
    responses: AskQuestionEntry[],
    cancelled?: boolean,
  ) => Promise<void>;
  onOpenConversation?: (conversationId: string) => void;
  onRemoveOptimistic?: (optimisticId: string, restoreDraft?: string) => void;
  childSubagents?: SubagentChildSummary[];
}) {
  const renderedContent = useMemo(
    () => renderMarkdown(msg.content ?? ""),
    [msg.content],
  );

  if (msg.step) {
    // File permission request — render dedicated card
    if (msg.type === "CORTEX_STEP_TYPE_FILE_PERMISSION") {
      const fpr = getFilePermissionRequest(msg.step);
      if (fpr) {
        return (
          <div className="message system">
            <FilePermissionCard
              step={msg.step}
              permissionRequest={fpr}
              onFilePermission={onFilePermission}
              onGenericPermission={onCommandAction}
            />
          </div>
        );
      }
    }
    if (msg.type === "CORTEX_STEP_TYPE_PERMISSION") {
      const permission = getPermissionRequest(msg.step);
      if (permission) {
        return (
          <div className="message system">
            <PermissionCard
              key={JSON.stringify(permission)}
              step={msg.step}
              permissionRequest={permission}
              fallbackStepIndex={msg.stepIndex}
              onPermission={onCommandAction}
            />
          </div>
        );
      }
    }
    if (msg.type === "CORTEX_STEP_TYPE_ASK_QUESTION") {
      const askQuestion = getAskQuestionRequest(msg.step);
      if (askQuestion) {
        return (
          <div className="message system">
            <AskQuestionCard
              step={msg.step}
              askQuestionRequest={askQuestion}
              fallbackStepIndex={msg.stepIndex}
              fallbackTrajectoryId={cascadeId}
              onAskQuestion={onAskQuestion}
            />
          </div>
        );
      }
    }
    if (msg.type === "CORTEX_STEP_TYPE_RUN_COMMAND") {
      return (
        <div className="message system">
          <CommandCard step={msg.step} onCommandAction={onCommandAction} />
        </div>
      );
    }
    if (msg.type === "CORTEX_STEP_TYPE_CODE_ACTION") {
      return (
        <div className="message system">
          <CodeActionCard step={msg.step} />
        </div>
      );
    }
    if (msg.type === "CORTEX_STEP_TYPE_SUBAGENT") {
      return (
        <div className="message system">
          <SubagentCard
            step={msg.step}
            data={msg.subagent}
            onOpenConversation={onOpenConversation}
            childSubagents={childSubagents}
          />
        </div>
      );
    }
  }

  const isError = isErrorStepMessage(msg);

  return (
    <div className={`message system${isError ? " error-message" : ""}`}>
      <div className={`chat-block step-card info-card${isError ? " error-card" : ""}`}>
        <div className="step-card-header">
          {msg.icon && (
            <span className="step-card-icon">
              <MsgIcon name={msg.icon} />
            </span>
          )}
          <span
            className="info-card-text"
            dangerouslySetInnerHTML={{ __html: renderedContent }}
          />
          {isError && msg.optimisticId && onRemoveOptimistic && (
            <button
              type="button"
              className="msg-action-btn error-dismiss-btn"
              title="エラー表示を閉じる"
              aria-label="エラー表示を閉じる"
              onClick={() => onRemoveOptimistic(msg.optimisticId!)}
            >
              <IconX size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

function isInteractiveWaitingStep(msg: ChatMessage): boolean {
  return (
    msg.role === "system" &&
    (msg.step?.status === "CORTEX_STEP_STATUS_WAITING" ||
      msg.type === "CORTEX_STEP_TYPE_ASK_QUESTION" ||
      msg.type === "CORTEX_STEP_TYPE_GENERIC_WAITING")
  );
}

function isThinkingOnlyAssistantMessage(
  msg: ChatMessage,
  pinnedStepIndex?: number,
): boolean {
  return (
    msg.role === "assistant" &&
    Boolean(msg.thinking?.trim()) &&
    !msg.content?.trim() &&
    (!msg.media || msg.media.length === 0) &&
    msg.stepIndex !== pinnedStepIndex
  );
}

function summarizeWorkGroup(items: ChatMessage[]): {
  totalCount: number;
  hasRunning: boolean;
  breakdown: string;
} {
  let commands = 0;
  let edits = 0;
  let subagents = 0;
  let searches = 0;
  let reads = 0;
  let thoughts = 0;
  let others = 0;
  let hasRunning = false;

  for (const msg of items) {
    if (msg.step?.status === "CORTEX_STEP_STATUS_RUNNING") {
      hasRunning = true;
    }
    if (msg.role === "assistant") {
      thoughts++;
      continue;
    }
    if (msg.type === "CORTEX_STEP_TYPE_RUN_COMMAND") {
      commands++;
    } else if (msg.type === "CORTEX_STEP_TYPE_CODE_ACTION") {
      edits++;
    } else if (msg.type === "CORTEX_STEP_TYPE_SUBAGENT") {
      subagents++;
    } else if (msg.icon === "search" || msg.icon === "file-search") {
      searches++;
    } else if (
      msg.icon === "eye" ||
      msg.icon === "file" ||
      msg.icon === "folder" ||
      msg.icon === "list"
    ) {
      reads++;
    } else {
      others++;
    }
  }

  const parts: string[] = [];
  if (commands > 0) parts.push(`コマンド ${commands}`);
  if (edits > 0) parts.push(`編集 ${edits}`);
  if (reads > 0) parts.push(`閲覧 ${reads}`);
  if (searches > 0) parts.push(`検索 ${searches}`);
  if (subagents > 0) parts.push(`子チャット ${subagents}`);
  if (thoughts > 0) parts.push(`思考 ${thoughts}`);
  if (others > 0) parts.push(`処理 ${others}`);

  return {
    totalCount: items.length,
    hasRunning,
    breakdown: parts.join(" · "),
  };
}

const WorkStepsGroup = memo(function WorkStepsGroup({
  items,
  onFilePermission,
  onCommandAction,
  onAskQuestion,
  onOpenConversation,
  childSubagents,
}: {
  items: { msg: ChatMessage; index: number }[];
  onFilePermission: (
    trajectoryId: string,
    stepIndex: number,
    allow: boolean,
    scope: number,
    absolutePathUri: string,
  ) => void;
  onCommandAction?: (
    trajectoryId: string,
    stepIndex: number,
    approved: boolean,
  ) => Promise<void>;
  onAskQuestion?: (
    trajectoryId: string,
    stepIndex: number,
    responses: AskQuestionEntry[],
    cancelled?: boolean,
  ) => Promise<void>;
  onOpenConversation?: (conversationId: string) => void;
  childSubagents?: SubagentChildSummary[];
}) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(
    () => summarizeWorkGroup(items.map((entry) => entry.msg)),
    [items],
  );

  return (
    <div
      className={`system-group-container${summary.hasRunning ? " is-running" : ""}`}
      data-testid="work-steps-group"
    >
      <details
        className="system-group-details"
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary className="system-group-summary">
          <span className="system-group-chevron" aria-hidden="true">
            <IconChevron size={11} />
          </span>
          {summary.hasRunning && (
            <span className="system-group-live-dot" aria-hidden="true" />
          )}
          <span className="system-group-label">
            {summary.hasRunning
              ? `作業中... (${summary.totalCount}件)`
              : `作業内容 (${summary.totalCount}件)`}
          </span>
          {summary.breakdown && (
            <span className="system-group-meta">{summary.breakdown}</span>
          )}
        </summary>
        <div className="system-group-content">
          {items.map(({ msg, index }) => {
            const key = msg.optimisticId ?? `${msg.stepIndex}-${index}`;
            if (msg.role === "assistant" && msg.thinking) {
              return (
                <div key={key} className="thinking-only-message">
                  <div className="thinking-only-body">
                    <ImplementationPlanBlock
                      plan={msg.thinking}
                      duration={msg.thinkingDuration}
                    />
                  </div>
                </div>
              );
            }
            return (
              <SystemMessage
                key={key}
                msg={msg}
                onFilePermission={onFilePermission}
                onCommandAction={onCommandAction}
                onAskQuestion={onAskQuestion}
                onOpenConversation={onOpenConversation}
                childSubagents={childSubagents}
              />
            );
          })}
        </div>
      </details>
    </div>
  );
});

interface MediaItem {
  mimeType?: string;
  inlineData?: string;
  payload?: { case?: string; value?: string };
}

/** Render media thumbnails from a user message */
function MediaThumbs({
  media,
  onImageClick,
}: {
  media: unknown[];
  onImageClick?: (src: string) => void;
}) {
  return (
    <div className="message-media">
      {media.map((m, i) => {
        const item = m as MediaItem;
        const mimeType = item.mimeType ?? "image/png";
        const inlineData =
          item.inlineData ??
          (item.payload?.case === "inlineData"
            ? item.payload.value
            : undefined);
        if (!inlineData) return null;
        const src = `data:${mimeType};base64,${inlineData}`;
        return (
          <img
            key={i}
            src={src}
            alt="attachment"
            className="message-media-thumb"
            onClick={() => onImageClick?.(src)}
          />
        );
      })}
    </div>
  );
}

/** Copy message text button */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="msg-action-btn"
      title="コピー"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}

/** Memoized message bubble — prevents WS-driven re-renders from destroying caret/selection */
interface MessageBubbleProps {
  msg: ChatMessage;
  isLocked: boolean;
  isUnconfirmed: boolean;
  suppressImplementationPlan?: boolean;
  onRevert: (stepIndex: number, editText?: string) => void;
  onEditComment?: (
    stepIndex: number,
    editedText: string,
    optimisticId?: string,
  ) => Promise<boolean> | void;
  onRemoveComment?: (stepIndex: number) => void;
  onRemoveOptimistic?: (optimisticId: string, restoreDraft?: string) => void;
  onImageClick: (src: string) => void;
}

const MessageBubble = memo(
  function MessageBubble({
    msg,
    isLocked,
    isUnconfirmed,
    suppressImplementationPlan = false,
    onRevert,
    onEditComment,
    onRemoveComment,
    onRemoveOptimistic,
    onImageClick,
  }: MessageBubbleProps) {
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editValue, setEditValue] = useState(msg.content);
    const [isSavingEdit, setIsSavingEdit] = useState(false);
    const [longTextExpanded, setLongTextExpanded] = useState(false);
    const editInputRef = useRef<HTMLTextAreaElement>(null);

    const contentLineCount = useMemo(
      () => (msg.content ? msg.content.split(/\r?\n/).length : 0),
      [msg.content],
    );
    const isLongUserMessage =
      msg.role === "user" &&
      (contentLineCount >= 10 || (msg.content?.length ?? 0) >= 500);
    const isVeryLongAssistantMessage =
      msg.role === "assistant" &&
      (contentLineCount >= 40 || (msg.content?.length ?? 0) >= 2400);
    const isCollapsibleLongMessage =
      isLongUserMessage || isVeryLongAssistantMessage;
    const isCollapsedLong = isCollapsibleLongMessage && !longTextExpanded;

    useEffect(() => {
      if (!confirmDelete) return;
      const timer = setTimeout(() => setConfirmDelete(false), 3500);
      return () => clearTimeout(timer);
    }, [confirmDelete]);

    useEffect(() => {
      if (!isEditing) return;
      const el = editInputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.style.height = "auto";
      el.style.height = `${Math.min(Math.max(el.scrollHeight, 68), 320)}px`;
    }, [isEditing]);

    const renderedContent = useMemo(
      () => (msg.content ? renderMarkdown(msg.content) : ""),
      [msg.content],
    );
    const showImplementationPlan =
      Boolean(msg.thinking) && !suppressImplementationPlan;

    const isThinkingOnly =
      showImplementationPlan &&
      !msg.content &&
      (!msg.media || msg.media.length === 0);

    if (
      !showImplementationPlan &&
      !msg.content &&
      (!msg.media || msg.media.length === 0)
    ) {
      return null;
    }

    if (isThinkingOnly && msg.thinking) {
      return (
        <div
          className={`message ${msg.role} thinking-only-message${isUnconfirmed ? " unconfirmed" : ""}`}
        >
          <div className="thinking-only-body">
            <ImplementationPlanBlock
              plan={msg.thinking}
              duration={msg.thinkingDuration}
            />
          </div>
        </div>
      );
    }

    const isUser = msg.role === "user";
    const isOptimisticLocal = Boolean(msg.optimisticId) && msg.stepIndex < 0;
    const isFailedLocal = msg.optimisticState === "failed";
    const canRevertCommitted = msg.stepIndex >= 0;
    const canRemoveCommitted = isUser && msg.stepIndex >= 0 && Boolean(onRemoveComment);
    const canRevertLocal = isUser && isOptimisticLocal && Boolean(onRemoveOptimistic);
    const canRemoveLocal = isUser && isOptimisticLocal && Boolean(onRemoveOptimistic);
    const canEditUser =
      isUser && (canRevertCommitted || canRevertLocal) && Boolean(onEditComment);
    const revertDisabled = isLocked && !isFailedLocal;

    const handleStartEdit = () => {
      if (revertDisabled || !canEditUser) return;
      setConfirmDelete(false);
      setEditValue(msg.content);
      setIsEditing(true);
    };

    const handleCancelEdit = () => {
      setIsEditing(false);
      setIsSavingEdit(false);
      setEditValue(msg.content);
    };

    const handleSubmitEdit = async () => {
      const trimmed = editValue.trim();
      if (!trimmed || isSavingEdit || !onEditComment) return;
      setIsSavingEdit(true);
      try {
        const result = await onEditComment(
          msg.stepIndex,
          trimmed,
          isOptimisticLocal ? msg.optimisticId : undefined,
        );
        if (result !== false) {
          setIsEditing(false);
        }
      } finally {
        setIsSavingEdit(false);
      }
    };

    return (
      <div
        className={`message ${msg.role}${isUnconfirmed ? " unconfirmed" : ""}${isFailedLocal ? " failed" : ""}${isEditing ? " editing" : ""}`}
      >
        <div className={isUser ? "chat-block message-body" : "message-body"}>
          {showImplementationPlan && msg.thinking && (
            <ImplementationPlanBlock
              plan={msg.thinking}
              duration={msg.thinkingDuration}
            />
          )}
          {msg.media && msg.media.length > 0 && (
            <MediaThumbs media={msg.media} onImageClick={onImageClick} />
          )}
          {isEditing ? (
            <div className="msg-edit-box">
              <textarea
                ref={editInputRef}
                className="msg-edit-textarea"
                value={editValue}
                disabled={isSavingEdit}
                aria-label="コメントを編集"
                onChange={(e) => {
                  setEditValue(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(Math.max(e.target.scrollHeight, 68), 320)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    handleCancelEdit();
                  } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void handleSubmitEdit();
                  }
                }}
              />
              <div className="msg-edit-actions">
                <button
                  type="button"
                  className="msg-action-pill"
                  onClick={handleCancelEdit}
                  disabled={isSavingEdit}
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  className="msg-action-pill primary"
                  onClick={() => void handleSubmitEdit()}
                  disabled={isSavingEdit || !editValue.trim()}
                >
                  {isSavingEdit ? "送信中..." : "保存して再送信"}
                </button>
              </div>
            </div>
          ) : (
            msg.content && (
              <>
                <div
                  className={`msg-markdown-wrap${isCollapsedLong ? " is-collapsed-long" : ""}`}
                >
                  <MarkdownContent html={renderedContent} />
                  {isCollapsedLong && (
                    <div className="msg-long-fade" aria-hidden="true" />
                  )}
                </div>
                {isCollapsibleLongMessage && (
                  <button
                    type="button"
                    className="msg-long-toggle-btn"
                    onClick={() => setLongTextExpanded((v) => !v)}
                    data-testid="msg-long-toggle-btn"
                  >
                    {longTextExpanded
                      ? "▲ 折りたたむ"
                      : `▼ 全文を表示（${contentLineCount}行 · ${msg.content.length}文字）`}
                  </button>
                )}
              </>
            )
          )}
          {!isEditing && msg.content && (
            <div className="msg-actions">
              {canEditUser && (
                <button
                  type="button"
                  className={`msg-action-pill ${revertDisabled ? "locked" : ""}`}
                  onClick={handleStartEdit}
                  title="このコメントをその場で編集して再送信する"
                  disabled={revertDisabled}
                >
                  <IconPencil size={12} />
                  <span>編集</span>
                </button>
              )}
              {(canRevertCommitted || canRevertLocal) && (
                <button
                  type="button"
                  className={`msg-action-pill ${revertDisabled ? "locked" : ""}`}
                  onClick={() => {
                    if (revertDisabled) return;
                    if (canRevertLocal && msg.optimisticId && onRemoveOptimistic) {
                      onRemoveOptimistic(msg.optimisticId, msg.content);
                      return;
                    }
                    onRevert(msg.stepIndex, isUser ? msg.content : undefined);
                  }}
                  title={
                    isUser
                      ? "このコメントを入力欄に戻してやり直す"
                      : "この返答の直前まで巻き戻す"
                  }
                  disabled={revertDisabled}
                >
                  <IconUndo size={12} />
                  <span>戻す</span>
                </button>
              )}
              {(canRemoveCommitted || canRemoveLocal) && (
                <button
                  type="button"
                  className={`msg-action-pill danger${confirmDelete ? " confirming" : ""} ${revertDisabled ? "locked" : ""}`}
                  onClick={() => {
                    if (revertDisabled) return;
                    if (canRemoveLocal && msg.optimisticId && onRemoveOptimistic) {
                      onRemoveOptimistic(msg.optimisticId);
                      return;
                    }
                    if (!confirmDelete) {
                      setConfirmDelete(true);
                      return;
                    }
                    setConfirmDelete(false);
                    onRemoveComment?.(msg.stepIndex);
                  }}
                  title={
                    canRemoveLocal
                      ? "このコメントを除去する"
                      : confirmDelete
                        ? "もう一度クリックするとこのコメントとそれ以降を除去します"
                        : "このコメント（とそれ以降）を除去する"
                  }
                  disabled={revertDisabled}
                >
                  <IconTrash size={12} />
                  <span>{confirmDelete ? "削除する？" : "削除"}</span>
                </button>
              )}
              <CopyButton text={msg.content} />
            </div>
          )}
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.msg.content === next.msg.content &&
    prev.msg.thinking === next.msg.thinking &&
    prev.msg.thinkingDuration === next.msg.thinkingDuration &&
    prev.msg.stepIndex === next.msg.stepIndex &&
    prev.msg.role === next.msg.role &&
    prev.msg.media === next.msg.media &&
    prev.msg.optimisticId === next.msg.optimisticId &&
    prev.msg.optimisticState === next.msg.optimisticState &&
    prev.isLocked === next.isLocked &&
    prev.isUnconfirmed === next.isUnconfirmed &&
    prev.suppressImplementationPlan === next.suppressImplementationPlan &&
    prev.onEditComment === next.onEditComment &&
    prev.onRemoveComment === next.onRemoveComment &&
    prev.onRemoveOptimistic === next.onRemoveOptimistic,
);

/** Fullscreen image lightbox with swipe-down-to-dismiss */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);
  const DISMISS_THRESHOLD = 120;

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    startY.current = e.touches[0].clientY;
    setDragging(true);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const dy = e.touches[0].clientY - startY.current;
    // Only allow downward drag
    setDragY(Math.max(0, dy));
  }, []);

  const handleTouchEnd = useCallback(() => {
    setDragging(false);
    if (dragY > DISMISS_THRESHOLD) {
      onClose();
    } else {
      setDragY(0);
    }
  }, [dragY, onClose]);

  const progress = Math.min(dragY / DISMISS_THRESHOLD, 1);
  const overlayOpacity = 0.9 - progress * 0.5;

  return (
    <div
      className="lightbox-overlay"
      style={{ backgroundColor: `rgba(0, 0, 0, ${overlayOpacity})` }}
      onClick={onClose}
    >
      <img
        src={src}
        className="lightbox-img"
        alt="Expanded"
        style={{
          transform: `translateY(${dragY}px) scale(${1 - progress * 0.1})`,
          transition: dragging ? "none" : "transform 0.25s ease-out",
        }}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />
    </div>
  );
}

export function ChatPanel({
  cascadeId,
  targetApp = "all",
  onRevert,
  onEditComment,
  onRemoveComment,
  onRemoveOptimistic,
  onFilePermission,
  onCommandAction,
  onAskQuestion,
  onConfirmOptimistic,
  optimisticMessages = [],
  refreshKey = 0,
  hardRefreshKey = 0,
  totalStepCount,
  isConversationRunning = false,
  browserNotificationsEnabled = false,
  conversationTitle,
  childSubagents,
  onSidebarRefresh,
  onOpenConversation,
}: Props) {
  const {
    steps: rawSteps,
    baseOffset,
    loading,
    error: stepsError,
    refresh,
    hardRefresh,
    hasMore,
    loadingOlder,
    loadOlder,
    wsRunning,
  } = useStepsStream(
    cascadeId,
    totalStepCount,
    onSidebarRefresh,
    isConversationRunning,
    browserNotificationsEnabled,
    targetApp,
  );

  useChatNotifications({
    cascadeId,
    steps: rawSteps,
    loading,
    wsRunning,
    isConversationRunning,
    enabled: browserNotificationsEnabled,
    conversationTitle,
  });

  // Soft re-fetch when refreshKey changes (e.g. after send)
  const prevKeyRef = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey !== prevKeyRef.current) {
      prevKeyRef.current = refreshKey;
      refresh();
    }
  }, [refreshKey, refresh]);

  // Hard re-fetch when hardRefreshKey changes (e.g. after revert/stop)
  const prevHardKeyRef = useRef(hardRefreshKey);
  useEffect(() => {
    if (hardRefreshKey !== prevHardKeyRef.current) {
      prevHardKeyRef.current = hardRefreshKey;
      hardRefresh();
    }
  }, [hardRefreshKey, hardRefresh]);

  // Reset scroll state when switching chats
  const prevCascadeRef = useRef(cascadeId);
  useEffect(() => {
    if (cascadeId !== prevCascadeRef.current) {
      prevCascadeRef.current = cascadeId;
      didInitialScroll.current = false;
    }
  }, [cascadeId]);

  const serverMessages = useMemo(
    () => stepsToMessages(rawSteps, baseOffset),
    [rawSteps, baseOffset],
  );
  const liveImplementationPlan = useMemo(
    () => latestImplementationPlan(rawSteps, baseOffset),
    [rawSteps, baseOffset],
  );
  const {
    messages,
    confirmedOptimisticIds,
    hasUnconfirmedOptimistic,
  } = useMemo(
    () => mergeOptimisticMessages(serverMessages, optimisticMessages),
    [serverMessages, optimisticMessages],
  );

  useEffect(() => {
    if (confirmedOptimisticIds.length === 0 || !onConfirmOptimistic) return;
    onConfirmOptimistic(confirmedOptimisticIds);
  }, [confirmedOptimisticIds, onConfirmOptimistic]);

  const isLocked = wsRunning || hasUnconfirmedOptimistic;
  const showTyping = wsRunning || hasUnconfirmedOptimistic;
  const liveImplementationPlanActive =
    showTyping && liveImplementationPlan !== null;
  // Only show pinned implementation plan while conversation is actively working.
  // Once finished, thinking stays cleanly in the assistant message without leaving an in-progress frame.
  const pinnedImplementationPlan =
    liveImplementationPlan && liveImplementationPlanActive
      ? liveImplementationPlan
      : null;
  const pinnedPlanInsertBeforeMessageIndex = useMemo(() => {
    if (!pinnedImplementationPlan) return -1;
    return messages.findIndex(
      (msg) =>
        msg.role === "assistant" &&
        msg.stepIndex >= pinnedImplementationPlan.stepIndex &&
        Boolean(msg.content.trim()),
    );
  }, [messages, pinnedImplementationPlan]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const didInitialScroll = useRef(false);
  const isNearBottom = useRef(true);
  const scrollingToBottomRef = useRef(false);
  const scrollToBottomTimerRef = useRef<number | null>(null);
  const showScrollBtnRef = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const prevMsgCount = useRef(messages.length);
  const suppressScroll = useRef(false);

  // 会話切替時・アンマウント時にスクロールボタン状態をリセット
  useEffect(() => {
    isNearBottom.current = true;
    scrollingToBottomRef.current = false;
    if (scrollToBottomTimerRef.current !== null) {
      window.clearTimeout(scrollToBottomTimerRef.current);
      scrollToBottomTimerRef.current = null;
    }
    showScrollBtnRef.current = false;
    setShowScrollBtn(false);
  }, [cascadeId]);

  useEffect(() => {
    return () => {
      if (scrollToBottomTimerRef.current !== null) {
        window.clearTimeout(scrollToBottomTimerRef.current);
        scrollToBottomTimerRef.current = null;
      }
    };
  }, []);

  // Auto-scroll: on first render (instant) and when new messages arrive while near bottom
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (!didInitialScroll.current && messages.length > 0) {
      // eslint-disable-next-line react-hooks/immutability
      didInitialScroll.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }

    // New messages arrived and user was near the bottom → follow
    if (messages.length > prevMsgCount.current && isNearBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevMsgCount.current = messages.length;
  }, [messages.length]);

  // Keep scroll at bottom if content resizes (e.g., images loading, markdown expanding)
  useLayoutEffect(() => {
    const innerEl = innerRef.current;
    const scrollEl = scrollRef.current;
    if (!innerEl || !scrollEl || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (didInitialScroll.current && isNearBottom.current && !suppressScroll.current) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
        return;
      }
      if (!suppressScroll.current && !scrollingToBottomRef.current) {
        const distFromBottom =
          scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
        const shouldShow = distFromBottom > 160;
        if (shouldShow !== showScrollBtnRef.current) {
          showScrollBtnRef.current = shouldShow;
          setShowScrollBtn(shouldShow);
        }
      }
    });

    observer.observe(innerEl);
    return () => observer.disconnect();
  }, []);

  // Lazy load older steps when user scrolls to top
  const loadOlderLock = useRef(false);
  const lastScrollTopRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || suppressScroll.current) return;
    const prevTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    const scrollingUp = el.scrollTop < prevTop - 2;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;

    // 一番下へジャンプ中のスムーズスクロールは途中フレームでボタンを再表示しない
    if (scrollingToBottomRef.current) {
      if (scrollingUp) {
        scrollingToBottomRef.current = false;
        if (scrollToBottomTimerRef.current !== null) {
          window.clearTimeout(scrollToBottomTimerRef.current);
          scrollToBottomTimerRef.current = null;
        }
      } else {
        if (distFromBottom < 24) {
          scrollingToBottomRef.current = false;
          isNearBottom.current = true;
          if (scrollToBottomTimerRef.current !== null) {
            window.clearTimeout(scrollToBottomTimerRef.current);
            scrollToBottomTimerRef.current = null;
          }
        }
        return;
      }
    }

    // Only trigger re-render when the button visibility actually changes
    const shouldShow = distFromBottom > 160;
    if (shouldShow !== showScrollBtnRef.current) {
      showScrollBtnRef.current = shouldShow;
      setShowScrollBtn(shouldShow);
    }
    // 上方向スクロール中は絶対に底へ引き戻されないよう即座に追従解除
    isNearBottom.current = scrollingUp ? false : distFromBottom < 80;

    // Trigger lazy load when near the top (only after initial scroll-to-bottom)
    if (
      didInitialScroll.current &&
      el.scrollTop < 200 &&
      hasMore &&
      !loadingOlder &&
      !loadOlderLock.current
    ) {
      loadOlderLock.current = true;
      const prevHeight = el.scrollHeight;
      suppressScroll.current = true;
      loadOlder().then((count) => {
        if (count > 0 && scrollRef.current) {
          // Preserve scroll position: offset by the height of prepended content
          requestAnimationFrame(() => {
            if (scrollRef.current) {
              const newHeight = scrollRef.current.scrollHeight;
              scrollRef.current.scrollTop += newHeight - prevHeight;
            }
            // Allow one more frame for the browser to settle before re-enabling
            requestAnimationFrame(() => {
              suppressScroll.current = false;
              loadOlderLock.current = false;
            });
          });
        } else {
          suppressScroll.current = false;
          loadOlderLock.current = false;
        }
      });
    }
  }, [hasMore, loadingOlder, loadOlder]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottom.current = true;
    scrollingToBottomRef.current = true;
    showScrollBtnRef.current = false;
    setShowScrollBtn(false);

    if (scrollToBottomTimerRef.current !== null) {
      window.clearTimeout(scrollToBottomTimerRef.current);
    }

    if (typeof el.scrollTo === "function") {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: "smooth",
      });
    } else {
      el.scrollTop = el.scrollHeight;
    }

    // ストリーミング中などで高さが伸びた場合も確実に最新最下部へ着地させる
    scrollToBottomTimerRef.current = window.setTimeout(() => {
      scrollToBottomTimerRef.current = null;
      if (scrollingToBottomRef.current && scrollRef.current) {
        scrollingToBottomRef.current = false;
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        isNearBottom.current = true;
      }
    }, 420);
  }, []);

  // Prevent infinite retry of broken images rendered from markdown.
  // When an <img> 404s, mark it so subsequent re-renders don't re-request it.
  const failedImages = useRef<Set<string>>(new Set());
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const imgs = el.querySelectorAll<HTMLImageElement>(
      ".message-body img:not([data-failed])",
    );
    imgs.forEach((img) => {
      // If this src already failed, kill it immediately
      if (failedImages.current.has(img.src)) {
        img.dataset.failed = "1";
        img.removeAttribute("src");
        img.alt = "⚠ 画像が見つかりません";
        return;
      }
      img.addEventListener(
        "error",
        () => {
          failedImages.current.add(img.src);
          img.dataset.failed = "1";
          img.removeAttribute("src");
          img.alt = "⚠ 画像が見つかりません";
        },
        { once: true },
      );
    });
  });

  // Open lightbox when clicking markdown-rendered <img> in message bodies.
  // Uses React onClick (synthetic event delegation) so it survives dangerouslySetInnerHTML DOM replacement.
  const handleImgClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (
      target.tagName === "IMG" &&
      target.closest(".message-body") &&
      !target.hasAttribute("data-failed")
    ) {
      e.preventDefault();
      setLightboxSrc((target as HTMLImageElement).src);
    }
  }, []);

  const timelineItems = useMemo(() => {
    type TimelineEntry =
      | { kind: "single"; msg: ChatMessage; index: number }
      | {
          kind: "work_group";
          items: { msg: ChatMessage; index: number }[];
          firstIndex: number;
          lastIndex: number;
        };

    const result: TimelineEntry[] = [];
    let workBuffer: { msg: ChatMessage; index: number }[] = [];
    const pinnedStepIndex = pinnedImplementationPlan?.stepIndex;

    const flushWorkBuffer = () => {
      if (workBuffer.length === 0) return;
      const hasSystemStep = workBuffer.some(
        (entry) => entry.msg.role === "system",
      );
      if (hasSystemStep) {
        result.push({
          kind: "work_group",
          items: workBuffer,
          firstIndex: workBuffer[0].index,
          lastIndex: workBuffer[workBuffer.length - 1].index,
        });
      } else {
        for (const entry of workBuffer) {
          result.push({
            kind: "single",
            msg: entry.msg,
            index: entry.index,
          });
        }
      }
      workBuffer = [];
    };

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const collapsible =
        (msg.role === "system" &&
          !isInteractiveWaitingStep(msg) &&
          !isErrorStepMessage(msg)) ||
        isThinkingOnlyAssistantMessage(msg, pinnedStepIndex);

      if (collapsible) {
        workBuffer.push({ msg, index: i });
      } else {
        flushWorkBuffer();
        result.push({ kind: "single", msg, index: i });
      }
    }
    flushWorkBuffer();

    return result;
  }, [messages, pinnedImplementationPlan?.stepIndex]);

  if (loading && messages.length === 0) {
    return (
      <div className="chat-area">
        <div className="chat-empty">
          <div className="loading-spinner" />
        </div>
      </div>
    );
  }

  if (messages.length === 0 && stepsError) {
    return (
      <div className="chat-area">
        <div className="chat-empty">
          <div className="chat-empty-icon">
            <IconMessageCircle size={48} />
          </div>
          <div className="chat-empty-text">
            チャットの読み込みに失敗しました（自動再接続中…）
          </div>
          <div
            style={{
              marginTop: 8,
              fontSize: 12,
              opacity: 0.7,
              maxWidth: 420,
              textAlign: "center",
              wordBreak: "break-word",
            }}
          >
            {stepsError}
          </div>
          <button
            type="button"
            className="btn-primary"
            style={{ marginTop: 14, padding: "6px 14px", borderRadius: 8 }}
            onClick={hardRefresh}
          >
            再読み込み
          </button>
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="chat-area">
        <div className="chat-empty">
          <div className="chat-empty-icon">
            <IconMessageCircle size={48} />
          </div>
          <div className="chat-empty-text">まだメッセージはありません</div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-panel-viewport">
      <div
        className="chat-area"
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={(e) => {
          if (e.deltaY < 0) {
            isNearBottom.current = false;
            scrollingToBottomRef.current = false;
            if (scrollToBottomTimerRef.current !== null) {
              window.clearTimeout(scrollToBottomTimerRef.current);
              scrollToBottomTimerRef.current = null;
            }
          }
        }}
        onTouchStart={(e) => {
          touchStartYRef.current = e.touches[0]?.clientY ?? null;
        }}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY;
          if (
            typeof y === "number" &&
            touchStartYRef.current !== null &&
            y > touchStartYRef.current + 6
          ) {
            // 指を下にドラッグ＝チャットを上にスクロール中なので自動追従を即解除
            isNearBottom.current = false;
            scrollingToBottomRef.current = false;
            if (scrollToBottomTimerRef.current !== null) {
              window.clearTimeout(scrollToBottomTimerRef.current);
              scrollToBottomTimerRef.current = null;
            }
          }
          // Dismiss iOS keyboard when scrolling chat area
          const el = document.activeElement;
          if (
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLInputElement
          ) {
            el.blur();
          }
        }}
      >
      <div className="chat-area-inner" ref={innerRef} onClick={handleImgClick}>
        {loadingOlder && (
          <div className="loading-older">
            <div className="loading-spinner" />
          </div>
        )}

        {timelineItems.map((entry) => {
          if (entry.kind === "work_group") {
            const first = entry.items[0];
            const groupKey = `work-${first.msg.stepIndex}-${entry.firstIndex}`;
            const insertPinnedBefore =
              pinnedImplementationPlan &&
              pinnedPlanInsertBeforeMessageIndex >= entry.firstIndex &&
              pinnedPlanInsertBeforeMessageIndex <= entry.lastIndex ? (
                <PinnedImplementationPlanMessage
                  implementationPlan={pinnedImplementationPlan}
                  live={liveImplementationPlanActive}
                />
              ) : null;
            return (
              <Fragment key={groupKey}>
                {insertPinnedBefore}
                <WorkStepsGroup
                  items={entry.items}
                  onFilePermission={onFilePermission}
                  onCommandAction={onCommandAction}
                  onAskQuestion={onAskQuestion}
                  onOpenConversation={onOpenConversation}
                  childSubagents={childSubagents}
                />
              </Fragment>
            );
          }

          const { msg, index: i } = entry;
          const messageKey = msg.optimisticId ?? `${msg.stepIndex}-${i}`;
          const pinnedPlanNode =
            pinnedImplementationPlan &&
            i === pinnedPlanInsertBeforeMessageIndex ? (
              <PinnedImplementationPlanMessage
                implementationPlan={pinnedImplementationPlan}
                live={liveImplementationPlanActive}
              />
            ) : null;

          if (msg.role === "system") {
            return (
              <Fragment key={messageKey}>
                {pinnedPlanNode}
                <SystemMessage
                  msg={msg}
                  cascadeId={cascadeId}
                  onFilePermission={onFilePermission}
                  onCommandAction={onCommandAction}
                  onAskQuestion={onAskQuestion}
                  onOpenConversation={onOpenConversation}
                  onRemoveOptimistic={onRemoveOptimistic}
                  childSubagents={childSubagents}
                />
              </Fragment>
            );
          }

          return (
            <Fragment key={messageKey}>
              {pinnedPlanNode}
              <MessageBubble
                msg={msg}
                isLocked={isLocked}
                isUnconfirmed={isUnconfirmedOptimisticMessage(msg)}
                suppressImplementationPlan={
                  pinnedImplementationPlan?.stepIndex === msg.stepIndex
                }
                onRevert={onRevert}
                onEditComment={onEditComment}
                onRemoveComment={onRemoveComment}
                onRemoveOptimistic={onRemoveOptimistic}
                onImageClick={setLightboxSrc}
              />
            </Fragment>
          );
        })}
        {pinnedImplementationPlan && pinnedPlanInsertBeforeMessageIndex < 0 && (
          <PinnedImplementationPlanMessage
            implementationPlan={pinnedImplementationPlan}
            live={liveImplementationPlanActive}
          />
        )}
        {showTyping && (
          <div className="message assistant">
            <div className="message-body">
              <div className="typing-indicator">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        )}
      </div>
      </div>
      {showScrollBtn && (
        <button
          type="button"
          className="scroll-to-bottom-btn"
          data-testid="scroll-to-bottom-btn"
          onClick={scrollToBottom}
          aria-label="一番下へスクロール"
          title="一番下（最新）へ移動"
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 5v14" />
            <path d="m19 12-7 7-7-7" />
          </svg>
        </button>
      )}
      {lightboxSrc &&
        createPortal(
          <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />,
          document.body,
        )}
    </div>
  );
}
