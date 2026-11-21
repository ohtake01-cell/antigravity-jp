import { useMemo, useState } from "react";
import {
  IconCopy,
  IconCheck,
  IconTerminal,
  IconPencil,
  IconFile,
  IconFileText,
  IconLock,
  IconMessageCircle,
  IconUsers,
} from "./Icons";
import type {
  AskQuestionEntry,
  AskQuestionOption,
  AskQuestionRequest,
  FilePermissionRequest,
  PermissionRequest,
  SubagentChildSummary,
  SubagentDisplayData,
  TrajectoryStep,
} from "../types";
import { subagentDataFromStep } from "../utils/subagents";

/** Extract file basename from a URI or path */
function basename(uriOrPath: string): string {
  const cleaned = uriOrPath.replace(/^file:\/\//, "");
  return cleaned.split("/").pop() ?? cleaned;
}

/** Inline copy button for step cards */
function StepCopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="msg-action-btn step-copy-btn"
      title="コピー"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </button>
  );
}

// ── File Permission Card ──

/** Permission scope enum values matching the LS proto */
const PERMISSION_SCOPE_ONCE = 1;
const PERMISSION_SCOPE_CONVERSATION = 2;

interface FilePermissionCardProps {
  step: TrajectoryStep;
  permissionRequest: FilePermissionRequest;
  onFilePermission: (
    trajectoryId: string,
    stepIndex: number,
    allow: boolean,
    scope: number,
    absolutePathUri: string,
  ) => void;
  onGenericPermission?: (
    trajectoryId: string,
    stepIndex: number,
    allow: boolean,
  ) => Promise<void>;
}

export function FilePermissionCard({
  step,
  permissionRequest,
  onFilePermission,
  onGenericPermission,
}: FilePermissionCardProps) {
  const [responded, setResponded] = useState(false);
  const isWaiting = step.status === "CORTEX_STEP_STATUS_WAITING";
  const usesGenericPermission = permissionRequest.responseKind === "permission";

  const trajectoryId =
    step.metadata?.sourceTrajectoryStepInfo?.trajectoryId ?? "";
  const stepIndex = step.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? 0;

  const path = permissionRequest.absolutePathUri;
  const displayPath = path.length > 60 ? "…" + path.slice(-55) : path;
  const isDir = permissionRequest.isDirectory ?? false;

  const handleResponse = (allow: boolean, scope: number) => {
    setResponded(true);
    if (usesGenericPermission) {
      void onGenericPermission?.(trajectoryId, stepIndex, allow);
      return;
    }
    onFilePermission(trajectoryId, stepIndex, allow, scope, path);
  };

  const canRespond = !usesGenericPermission || !!onGenericPermission;

  return (
    <div
      className={`chat-block step-card file-permission-card ${responded ? "cmd-ok" : isWaiting ? "cmd-wait" : ""}`}
    >
      <div className="step-card-header">
        <span className="step-card-icon">
          <IconLock size={12} />
        </span>
        <span className="step-card-desc">
          {permissionRequest.action === "write_file"
            ? "書き込みアクセスの許可リクエスト: "
            : permissionRequest.action === "read_file"
              ? "読み取りアクセスの許可リクエスト: "
              : "ファイルアクセスのリクエスト: "}
          <code className="step-card-file">{displayPath}</code>
          {isDir ? " (フォルダ)" : ""}
        </span>
      </div>
      {permissionRequest.blockReason && (
        <div className="step-card-cwd">
          {permissionRequest.blockReason
            .replace("BLOCK_REASON_", "")
            .replace(/_/g, " ")
            .toLowerCase()}
        </div>
      )}
      {isWaiting && !responded && canRespond && (
        <div className="step-card-actions file-permission-actions">
          <button
            className="approve-btn file-permission-btn deny"
            onClick={() => handleResponse(false, 0)}
          >
            拒否
          </button>
          {usesGenericPermission ? (
            <button
              className="approve-btn file-permission-btn allow-conversation"
              onClick={() => handleResponse(true, 0)}
            >
              許可
            </button>
          ) : (
            <>
              <button
                className="approve-btn file-permission-btn allow-once"
                onClick={() => handleResponse(true, PERMISSION_SCOPE_ONCE)}
              >
                1回のみ許可
              </button>
              <button
                className="approve-btn file-permission-btn allow-conversation"
                onClick={() =>
                  handleResponse(true, PERMISSION_SCOPE_CONVERSATION)
                }
              >
                この会話で許可
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Web / Tool Permission Card ──

interface PermissionCardProps {
  step: TrajectoryStep;
  permissionRequest: PermissionRequest;
  fallbackStepIndex: number;
  onPermission?: (
    trajectoryId: string,
    stepIndex: number,
    allow: boolean,
  ) => Promise<void>;
}

export function PermissionCard({
  step,
  permissionRequest,
  fallbackStepIndex,
  onPermission,
}: PermissionCardProps) {
  const [responded, setResponded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isWaiting = step.status === "CORTEX_STEP_STATUS_WAITING";
  const source = step.metadata?.sourceTrajectoryStepInfo;
  const action = permissionRequest.resource?.action ?? "";
  const target = permissionRequest.resource?.target ?? "";
  const toolName = step.metadata?.toolCall?.name;
  const genericSummary = step.generic?.args?.toolSummary;
  const description = step.metadata?.toolSummary ??
    (typeof genericSummary === "string" ? genericSummary : undefined);
  const detail = permissionRequest.triggerSource?.detail || toolName || action;

  const handleResponse = async (allow: boolean) => {
    if (!onPermission || responded) return;
    setResponded(true);
    setError(null);
    try {
      await onPermission(
        source?.trajectoryId ?? "",
        source?.stepIndex ?? fallbackStepIndex,
        allow,
      );
    } catch {
      setResponded(false);
      setError("応答を送信できませんでした。もう一度お試しください。");
    }
  };

  return (
    <div className={`chat-block step-card file-permission-card permission-card ${isWaiting ? "cmd-wait" : ""}`}>
      <div className="step-card-header">
        <span className="step-card-icon"><IconLock size={12} /></span>
        <span className="step-card-desc">
          {action === "read_url"
            ? "Webアクセスを許可しますか: "
            : "ツール実行を許可しますか: "}
          <code className="step-card-file">{target || toolName || action || "権限リクエスト"}</code>
        </span>
      </div>
      {(description || detail) && (
        <div className="step-card-cwd">
          {description || "権限リクエスト"}
          {detail && ` (${detail})`}
        </div>
      )}
      {error && <div className="step-card-cwd" role="alert">{error}</div>}
      {isWaiting && !responded && onPermission && (
        <div className="step-card-actions file-permission-actions">
          <button
            className="approve-btn file-permission-btn deny"
            onClick={() => void handleResponse(false)}
          >
            拒否
          </button>
          <button
            className="approve-btn file-permission-btn allow-conversation"
            onClick={() => void handleResponse(true)}
          >
            許可
          </button>
        </div>
      )}
    </div>
  );
}

// ── Ask Question Card ──

interface AskQuestionCardProps {
  step: TrajectoryStep;
  askQuestionRequest: AskQuestionRequest;
  fallbackStepIndex: number;
  fallbackTrajectoryId?: string;
  onAskQuestion?: (
    trajectoryId: string,
    stepIndex: number,
    responses: AskQuestionEntry[],
    cancelled?: boolean,
  ) => Promise<void>;
}

function optionId(
  questionIndex: number,
  optionIndex: number,
  option: AskQuestionOption,
): string {
  return option.id ?? option.text ?? `${questionIndex}-${optionIndex}`;
}

function responseFromQuestion(
  question: AskQuestionEntry,
  selectedOptionIds: string[],
  writeInResponse: string,
  skipped = false,
): AskQuestionEntry {
  return {
    question: question.question,
    options: question.options,
    isMultiSelect: question.isMultiSelect,
    selectedOptionIds,
    ...(writeInResponse.trim()
      ? { writeInResponse: writeInResponse.trim() }
      : {}),
    ...(skipped ? { skipped: true } : {}),
  };
}

export function AskQuestionCard({
  step,
  askQuestionRequest,
  fallbackStepIndex,
  fallbackTrajectoryId,
  onAskQuestion,
}: AskQuestionCardProps) {
  const questions = useMemo(
    () => askQuestionRequest.questions ?? [],
    [askQuestionRequest.questions],
  );
  const [selectedByQuestion, setSelectedByQuestion] = useState<
    Record<number, string[]>
  >(() =>
    Object.fromEntries(
      questions.map((question, index) => [
        index,
        question.selectedOptionIds ?? [],
      ]),
    ),
  );
  const [writeIns, setWriteIns] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      questions.map((question, index) => [
        index,
        question.writeInResponse ?? "",
      ]),
    ),
  );
  const [responded, setResponded] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const isWaiting = step.status === "CORTEX_STEP_STATUS_WAITING";
  const trajectoryId =
    step.metadata?.sourceTrajectoryStepInfo?.trajectoryId ??
    fallbackTrajectoryId ??
    "";
  const stepIndex =
    step.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? fallbackStepIndex;
  const canRespond =
    isWaiting && !responded && !!onAskQuestion && !!trajectoryId;

  const hasAnswer =
    questions.length > 0 &&
    questions.every((_, index) => {
      const selected = selectedByQuestion[index] ?? [];
      const writeIn = writeIns[index]?.trim() ?? "";
      return selected.length > 0 || writeIn.length > 0;
    });

  const setOptionSelected = (
    questionIndex: number,
    option: AskQuestionOption,
    optionIndex: number,
    isMultiSelect: boolean,
  ) => {
    const id = optionId(questionIndex, optionIndex, option);
    setSelectedByQuestion((prev) => {
      const existing = prev[questionIndex] ?? [];
      if (!isMultiSelect) {
        return { ...prev, [questionIndex]: [id] };
      }
      return {
        ...prev,
        [questionIndex]: existing.includes(id)
          ? existing.filter((value) => value !== id)
          : [...existing, id],
      };
    });
  };

  const buildResponses = (skipped = false): AskQuestionEntry[] =>
    questions.map((question, index) =>
      responseFromQuestion(
        question,
        skipped ? [] : (selectedByQuestion[index] ?? []),
        skipped ? "" : (writeIns[index] ?? ""),
        skipped,
      ),
    );

  const handleSubmit = async (skipped = false) => {
    if (!onAskQuestion || !canRespond || submitting) return;
    setSubmitting(true);
    setResponded(true);
    try {
      await onAskQuestion(trajectoryId, stepIndex, buildResponses(skipped));
    } catch {
      setResponded(false);
      setSubmitting(false);
    }
  };

  return (
    <div
      className={`chat-block step-card ask-question-card ${responded ? "cmd-ok" : isWaiting ? "cmd-wait" : ""}`}
    >
      <div className="step-card-header ask-question-header">
        <span className="step-card-icon">
          <IconMessageCircle size={12} />
        </span>
        <span className="step-card-desc">
          {isWaiting && !responded
            ? "⏳ 確認・選択のリクエスト（回答待ち）"
            : "確認・選択のリクエスト"}
        </span>
      </div>
      <div className="ask-question-body">
        {questions.map((question, questionIndex) => {
          const options = question.options ?? [];
          const selected =
            selectedByQuestion[questionIndex] ??
            question.selectedOptionIds ??
            [];
          const currentWriteIn =
            writeIns[questionIndex] ?? question.writeInResponse ?? "";
          // Antigravity 本体の仕様通り、回答待ち時は常に「その他（自由記述）」欄を表示し、
          // 完了後も自由記述の回答があれば表示する
          const showWriteIn =
            canRespond || options.length === 0 || currentWriteIn.trim().length > 0;

          return (
            <div className="ask-question" key={questionIndex}>
              {question.question && (
                <div className="ask-question-text">
                  {questions.length > 1 ? `${questionIndex + 1}/${questions.length} ` : ""}
                  {question.question}
                  {question.isMultiSelect ? "（複数選択可）" : ""}
                </div>
              )}
              {options.length > 0 && (
                <div className="ask-question-options">
                  {options.map((option, optionIndex) => {
                    const id = optionId(questionIndex, optionIndex, option);
                    const active = selected.includes(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`ask-question-option ${active ? "active" : ""}`}
                        disabled={!canRespond}
                        onClick={() =>
                          setOptionSelected(
                            questionIndex,
                            option,
                            optionIndex,
                            !!question.isMultiSelect,
                          )
                        }
                      >
                        <span className="ask-question-option-index">
                          {optionIndex + 1}
                        </span>
                        <span className="ask-question-option-text">
                          {option.text ?? id}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {showWriteIn && (
                <textarea
                  className="ask-question-write-in"
                  aria-label="自由記述の回答"
                  placeholder={
                    options.length > 0
                      ? "その他（自由記述で回答する場合に入力…）"
                      : "自由記述で入力..."
                  }
                  value={currentWriteIn}
                  disabled={!canRespond}
                  onChange={(event) =>
                    setWriteIns((prev) => ({
                      ...prev,
                      [questionIndex]: event.target.value,
                    }))
                  }
                  rows={2}
                />
              )}
            </div>
          );
        })}
      </div>
      {canRespond && (
        <div className="step-card-actions ask-question-actions">
          <button
            className="approve-btn ask-question-btn skip"
            type="button"
            disabled={submitting}
            onClick={() => void handleSubmit(true)}
          >
            スキップ
          </button>
          <button
            className="approve-btn ask-question-btn submit"
            type="button"
            disabled={!hasAnswer || submitting}
            onClick={() => void handleSubmit(false)}
          >
            送信
          </button>
        </div>
      )}
    </div>
  );
}

// ── Command Card ──

interface CommandCardProps {
  step: TrajectoryStep;
  onCommandAction?: (
    trajectoryId: string,
    stepIndex: number,
    approved: boolean,
  ) => Promise<void>;
}

export function CommandCard({ step, onCommandAction }: CommandCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [responded, setResponded] = useState(false);
  const cmd = step.runCommand;
  if (!cmd) return null;

  const isWaiting = step.status === "CORTEX_STEP_STATUS_WAITING";
  // When waiting for approval, show the proposed command; otherwise show executed
  const command = isWaiting
    ? (cmd.proposedCommandLine ?? cmd.commandLine ?? cmd.command ?? "")
    : (cmd.commandLine ?? cmd.command ?? "");
  const output = cmd.combinedOutput?.full ?? cmd.output ?? "";
  const cwd = cmd.cwd;
  const exitCode = cmd.exitCode;

  const trajectoryId =
    step.metadata?.sourceTrajectoryStepInfo?.trajectoryId ?? "";
  const stepIndex = step.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? 0;

  const statusClass = isWaiting
    ? "cmd-wait"
    : exitCode === undefined
      ? ""
      : exitCode === 0
        ? "cmd-ok"
        : "cmd-fail";

  const handleAction = async (approved: boolean) => {
    if (!onCommandAction) return;
    setResponded(true);
    try {
      await onCommandAction(trajectoryId, stepIndex, approved);
    } catch {
      // Request failed — restore buttons so user can retry
      setResponded(false);
    }
  };

  return (
    <div className={`chat-block step-card command-card ${statusClass}`}>
      <button
        className="step-card-header"
        onClick={() => output && setExpanded((v) => !v)}
        title={output ? "出力を開閉" : undefined}
      >
        <span className="step-card-icon">
          <IconTerminal size={12} />
        </span>
        <code className="step-card-command">{command}</code>
        {output && (
          <span className={`step-card-chevron ${expanded ? "open" : ""}`}>
            ▾
          </span>
        )}
      </button>
      {cwd && <div className="step-card-cwd">{cwd}</div>}
      {isWaiting && !responded && onCommandAction && (
        <div className="step-card-actions command-action-bar">
          <span className="command-waiting-label">
            <span className="waiting-dot" />
            承認待ち
          </span>
          <div className="command-action-buttons">
            <button
              className="approve-btn command-action-btn reject"
              onClick={() => handleAction(false)}
            >
              却下
            </button>
            <button
              className="approve-btn command-action-btn approve"
              onClick={() => handleAction(true)}
            >
              承認
            </button>
          </div>
        </div>
      )}
      {expanded && output && <pre className="step-card-output">{output}</pre>}
      <StepCopyBtn text={output ? `$ ${command}\n${output}` : `$ ${command}`} />
    </div>
  );
}

// ── Code Action Card ──

interface CodeActionCardProps {
  step: TrajectoryStep;
}

/** Diff line types from the LS proto */
type DiffLineType =
  | "UNIFIED_DIFF_LINE_TYPE_UNCHANGED"
  | "UNIFIED_DIFF_LINE_TYPE_INSERT"
  | "UNIFIED_DIFF_LINE_TYPE_DELETE"
  | "UNIFIED_DIFF_LINE_TYPE_HUNK_HEADER";

interface DiffLine {
  text?: string;
  type: DiffLineType;
}

function diffLinePrefix(type: DiffLineType): string {
  if (type === "UNIFIED_DIFF_LINE_TYPE_INSERT") return "+";
  if (type === "UNIFIED_DIFF_LINE_TYPE_DELETE") return "-";
  if (type === "UNIFIED_DIFF_LINE_TYPE_HUNK_HEADER") return "@@";
  return " ";
}

function diffLineClass(type: DiffLineType): string {
  if (type === "UNIFIED_DIFF_LINE_TYPE_INSERT") return "diff-add";
  if (type === "UNIFIED_DIFF_LINE_TYPE_DELETE") return "diff-del";
  if (type === "UNIFIED_DIFF_LINE_TYPE_HUNK_HEADER") return "diff-hunk";
  return "";
}

export function CodeActionCard({ step }: CodeActionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const ca = step.codeAction;
  if (!ca) return null;

  const toolName = step.metadata?.toolCall?.name ?? "";

  const description = ca.description ?? "コード変更";
  const fileUri: string = ca.actionResult?.edit?.absoluteUri ?? "";
  const fileName = fileUri ? basename(fileUri) : "";
  const diffLines: DiffLine[] =
    ca.actionResult?.edit?.diff?.unifiedDiff?.lines ?? [];
  const hasDiff = diffLines.length > 0;

  // Determine icon based on tool
  let iconEl = <IconFileText size={12} />;
  if (toolName === "write_to_file") iconEl = <IconFile size={12} />;
  else if (
    toolName === "multi_replace_file_content" ||
    toolName === "replace_file_content"
  )
    iconEl = <IconPencil size={12} />;

  // Count additions/deletions
  const additions = diffLines.filter(
    (l) => l.type === "UNIFIED_DIFF_LINE_TYPE_INSERT",
  ).length;
  const deletions = diffLines.filter(
    (l) => l.type === "UNIFIED_DIFF_LINE_TYPE_DELETE",
  ).length;

  return (
    <div className="chat-block step-card code-card">
      <button
        className="step-card-header"
        onClick={() => hasDiff && setExpanded((v) => !v)}
        title={hasDiff ? "差分を開閉" : undefined}
      >
        <span className="step-card-icon">{iconEl}</span>
        <span className="diff-stat">
          <span className="diff-stat-add">+{additions}</span>
          <span className="diff-stat-del">-{deletions}</span>
        </span>
        {fileName && <code className="step-card-file">{fileName}</code>}
        <span className="step-card-desc">{description}</span>
        {hasDiff && (
          <span className={`step-card-chevron ${expanded ? "open" : ""}`}>
            ▾
          </span>
        )}
      </button>
      {expanded && hasDiff && (
        <div className="step-card-diff">
          {fileUri && (
            <div className="diff-file-header">
              {fileUri.replace("file://", "")}
            </div>
          )}
          <pre className="diff-content">
            {diffLines.map((line, i) => (
              <div key={i} className={`diff-line ${diffLineClass(line.type)}`}>
                <span className="diff-prefix">{diffLinePrefix(line.type)}</span>
                <span className="diff-text">{line.text ?? ""}</span>
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Subagent Card ──

const ACTIVE_SUBAGENT_STATUSES = new Set([
  "CORTEX_STEP_STATUS_GENERATING",
  "CORTEX_STEP_STATUS_QUEUED",
  "CORTEX_STEP_STATUS_PENDING",
  "CORTEX_STEP_STATUS_RUNNING",
  "CORTEX_STEP_STATUS_WAITING",
]);

const FAILED_SUBAGENT_STATUSES = new Set([
  "CORTEX_STEP_STATUS_INVALID",
  "CORTEX_STEP_STATUS_CANCELED",
  "CORTEX_STEP_STATUS_ERROR",
  "CORTEX_STEP_STATUS_INTERRUPTED",
]);

function subagentStatus(status?: string): {
  label?: string;
  className: string;
} {
  if (!status) return { className: "" };
  if (status === "CORTEX_STEP_STATUS_DONE") {
    return { label: "完了", className: "cmd-ok" };
  }
  if (FAILED_SUBAGENT_STATUSES.has(status)) {
    const labels: Record<string, string> = {
      CORTEX_STEP_STATUS_INVALID: "無効",
      CORTEX_STEP_STATUS_CANCELED: "キャンセル",
      CORTEX_STEP_STATUS_ERROR: "エラー",
      CORTEX_STEP_STATUS_INTERRUPTED: "中断",
    };
    return { label: labels[status], className: "cmd-fail" };
  }
  if (ACTIVE_SUBAGENT_STATUSES.has(status)) {
    const labels: Record<string, string> = {
      CORTEX_STEP_STATUS_GENERATING: "生成中",
      CORTEX_STEP_STATUS_QUEUED: "待機中",
      CORTEX_STEP_STATUS_PENDING: "準備中",
      CORTEX_STEP_STATUS_RUNNING: "実行中",
      CORTEX_STEP_STATUS_WAITING: "応答待ち",
    };
    return { label: labels[status], className: "cmd-wait" };
  }
  return { className: "" };
}

interface SubagentCardProps {
  step: TrajectoryStep;
  data?: SubagentDisplayData;
  onOpenConversation?: (conversationId: string) => void;
  childSubagents?: SubagentChildSummary[];
}

function resolveFallbackSubagentId(
  role: string,
  typeName: string,
  childSubagents?: SubagentChildSummary[],
): string | undefined {
  if (!childSubagents || childSubagents.length === 0) return undefined;
  const normRole = role.trim().toLowerCase();
  const normType = typeName.trim().toLowerCase();
  const exact = childSubagents.find(
    (child) => child.role.trim().toLowerCase() === normRole,
  );
  if (exact) return exact.id;
  if (normType && normType !== "subagent") {
    const byType = childSubagents.filter(
      (child) => child.typeName.trim().toLowerCase() === normType,
    );
    if (byType.length === 1) return byType[0].id;
  }
  return undefined;
}

export function SubagentCard({
  step,
  data,
  onOpenConversation,
  childSubagents,
}: SubagentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const display = data ?? subagentDataFromStep(step);
  if (!display) return null;

  const hasDetails = display.items.some((item) => item.details.length > 0);
  const status = subagentStatus(step.status);

  return (
    <div
      className={`chat-block step-card subagent-card ${status.className}`}
    >
      <button
        type="button"
        className="step-card-header"
        onClick={() => hasDetails && setExpanded((value) => !value)}
        title={hasDetails ? "サブエージェント詳細を開閉" : undefined}
        aria-expanded={hasDetails ? expanded : undefined}
      >
        <span className="step-card-icon">
          <IconUsers size={12} />
        </span>
        <span className="subagent-role">{display.title}</span>
        <span className="subagent-type-badge">{display.kind}</span>
        {display.action && (
          <span className="step-card-desc">{display.action}</span>
        )}
        {status.label && (
          <span className="subagent-status">{status.label}</span>
        )}
        {hasDetails && (
          <span className={`step-card-chevron ${expanded ? "open" : ""}`}>
            ▾
          </span>
        )}
      </button>
      <div className="subagent-list">
        {display.items.map((item, itemIndex) => {
          const resolvedConversationId =
            item.conversationId ||
            resolveFallbackSubagentId(item.role, item.typeName, childSubagents);
          return (
          <div
            className="subagent-entry"
            key={`${item.role}-${item.typeName}-${itemIndex}`}
          >
            <div className="subagent-entry-header">
              <span className="subagent-entry-role">{item.role}</span>
              <span className="subagent-type-badge">{item.typeName}</span>
              {item.model && (
                <span className="subagent-model">{item.model}</span>
              )}
              {resolvedConversationId && onOpenConversation && (
                <button
                  type="button"
                  className="sidebar-subagents-toggle"
                  onClick={() => onOpenConversation(resolvedConversationId)}
                  title="この子チャットを開く"
                >
                  子チャットを開く →
                </button>
              )}
            </div>
            {expanded && item.details.length > 0 && (
              <div className="subagent-details">
                {item.details.map((itemDetail, detailIndex) => (
                  <div
                    className="subagent-detail"
                    key={`${itemDetail.label}-${detailIndex}`}
                  >
                    <div className="subagent-prompt-label">
                      {itemDetail.label}:
                    </div>
                    <pre className="subagent-prompt-text">
                      {itemDetail.text}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}
