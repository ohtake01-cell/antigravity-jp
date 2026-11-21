import type { ChatMessage, ToolCallData, TrajectoryStep } from "../types";
import {
  getAskQuestionRequest,
  getFilePermissionRequest,
  getPermissionRequest,
} from "../utils/stepCards";
import {
  isSubagentToolName,
  subagentDataFromStep,
} from "../utils/subagents";

function textFromItems(items?: { text?: string }[]): string {
  if (!items) return "";
  return items
    .filter((item) => item.text?.trim())
    .map((item) => item.text!.trim())
    .join("\n\n");
}

function extractSubagentSystemPrompt(raw?: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const match = trimmed.match(/^\[Message\][\s\S]*?\bcontent=([\s\S]+)$/);
  if (!match) return null;
  const body = match[1].trim();
  if (
    !body ||
    body.startsWith("[Notice]") ||
    /^Task id "[^"]+" finished with result:/.test(body)
  ) {
    return null;
  }
  return body;
}

/** Extract displayable messages from raw trajectory steps */
export function stepsToMessages(
  steps: TrajectoryStep[],
  baseOffset = 0,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const pendingInvokeToolCalls: ToolCallData[] = [];
  const hasUserInput = steps.some(
    (s) => s.type === "CORTEX_STEP_TYPE_USER_INPUT",
  );

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const absIndex = baseOffset + i;
    const type = step.type;

    // Older AG trajectories put invoke_subagent arguments on the planner
    // response, followed by a payloadless native invocation marker.
    if (type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
      // Do not let an incomplete/truncated older invocation become the
      // fallback for a later planner turn.
      pendingInvokeToolCalls.length = 0;
      for (const toolCall of step.plannerResponse?.toolCalls ?? []) {
        if (toolCall.name === "invoke_subagent") {
          pendingInvokeToolCalls.push(toolCall);
        }
      }
    }

    // File permission request: emit as a dedicated message type
    const fpr = getFilePermissionRequest(step);
    if (fpr) {
      messages.push({
        role: "system",
        content: "",
        stepIndex: absIndex,
        type: "CORTEX_STEP_TYPE_FILE_PERMISSION",
        step,
      });
      continue;
    }

    // Commands already have a dedicated approval card. All other tools need
    // a generic card even when their underlying step type is not rendered.
    if (
      getPermissionRequest(step) &&
      !(type === "CORTEX_STEP_TYPE_RUN_COMMAND" && step.runCommand)
    ) {
      messages.push({
        role: "system",
        content: "",
        stepIndex: absIndex,
        type: "CORTEX_STEP_TYPE_PERMISSION",
        step,
      });
      continue;
    }

    const askQuestion = getAskQuestionRequest(step);
    if (
      askQuestion &&
      (type === "CORTEX_STEP_TYPE_ASK_QUESTION" ||
        step.requestedInteraction?.askQuestion)
    ) {
      messages.push({
        role: "system",
        content: "",
        stepIndex: absIndex,
        type: "CORTEX_STEP_TYPE_ASK_QUESTION",
        step,
      });
      continue;
    }

    const toolName = step.metadata?.toolCall?.name;
    const isNativeSubagent =
      type === "CORTEX_STEP_TYPE_INVOKE_SUBAGENT" ||
      type === "CORTEX_STEP_TYPE_SUBAGENT";
    const isSubagent = isSubagentToolName(toolName) || isNativeSubagent;

    if (isSubagent) {
      const fallbackToolCall = isNativeSubagent
        ? pendingInvokeToolCalls.shift()
        : undefined;
      if (!isNativeSubagent && toolName === "invoke_subagent") {
        pendingInvokeToolCalls.shift();
      }
      const subagent = subagentDataFromStep(step, fallbackToolCall);
      messages.push({
        role: "system",
        content: "",
        stepIndex: absIndex,
        type: "CORTEX_STEP_TYPE_SUBAGENT",
        step,
        subagent,
      });
      continue;
    }

    if (type === "CORTEX_STEP_TYPE_USER_INPUT" && step.userInput?.items) {
      const text = textFromItems(step.userInput.items);
      const media = step.userInput.media;
      if (text || (media && media.length > 0)) {
        messages.push({
          role: "user",
          content: text,
          stepIndex: absIndex,
          type,
          optimisticId: step.clientMessageId,
          media,
        });
      }
    } else if (
      !hasUserInput &&
      type === "CORTEX_STEP_TYPE_SYSTEM_MESSAGE" &&
      step.systemMessage?.message
    ) {
      const promptText = extractSubagentSystemPrompt(step.systemMessage.message);
      if (promptText) {
        messages.push({
          role: "user",
          content: promptText,
          stepIndex: absIndex,
          type,
        });
      }
    } else if (type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
      const pr = step.plannerResponse;
      if (!pr) continue;

      const itemText = textFromItems(pr.items);
      const text = pr.modifiedResponse?.trim() ? pr.modifiedResponse : itemText;
      const thinking = pr.thinking ?? "";
      const thinkingDuration = pr.thinkingDuration ?? "";

      if (text.trim() || thinking.trim()) {
        messages.push({
          role: "assistant",
          content: text,
          stepIndex: absIndex,
          type,
          thinking: thinking || undefined,
          thinkingDuration: thinkingDuration || undefined,
        });
      }
    } else if (type === "CORTEX_STEP_TYPE_RUN_COMMAND" && step.runCommand) {
      const cmd =
        step.runCommand.commandLine ??
        step.runCommand.command ??
        step.runCommand.proposedCommandLine ??
        "";
      if (cmd) {
        messages.push({
          role: "system",
          content: "",
          stepIndex: absIndex,
          type,
          step,
        });
      }
    } else if (type === "CORTEX_STEP_TYPE_CODE_ACTION" && step.codeAction) {
      messages.push({
        role: "system",
        content: "",
        stepIndex: absIndex,
        type,
        step,
      });
    } else if (
      type === "CORTEX_STEP_TYPE_COMMAND_STATUS" &&
      step.commandStatus
    ) {
      const cs = step.commandStatus;
      const cmdId = cs.commandId;
      const status = cs.status;
      const combined = cs.combined ?? "";
      for (let j = messages.length - 1; j >= 0; j--) {
        const m = messages[j];
        if (m.step?.runCommand && m.step.runCommand.commandId === cmdId) {
          if (status === "CORTEX_STEP_STATUS_DONE" && combined) {
            m.step.runCommand.combinedOutput = { full: combined };
          }
          break;
        }
      }
    } else if (
      type === "CORTEX_STEP_TYPE_SEND_COMMAND_INPUT" &&
      step.sendCommandInput
    ) {
      if (step.sendCommandInput.terminate) {
        messages.push({
          role: "system",
          content: `⏹ コマンドに終了シグナルを送信`,
          stepIndex: absIndex,
          type,
        });
      }
    } else if (type === "CORTEX_STEP_TYPE_GREP_SEARCH" && step.grepSearch) {
      const gs = step.grepSearch;
      const query = gs.query ?? "";
      const results = gs.results ?? [];
      const searchPath = (gs.searchPathUri ?? "").replace("file://", "");
      const pathLabel = searchPath.split("/").pop() ?? searchPath;
      messages.push({
        role: "system",
        content: `\`${query}\` を **${pathLabel}** で検索 — ${results.length}件`,
        stepIndex: absIndex,
        type,
        icon: "search",
      });
    } else if (type === "CORTEX_STEP_TYPE_VIEW_FILE" && step.viewFile) {
      const vf = step.viewFile;
      const uri = (vf.absolutePathUri ?? "").replace("file://", "");
      const name = uri.split("/").pop() ?? uri;
      const range =
        vf.startLine && vf.endLine ? ` #L${vf.startLine}-${vf.endLine}` : "";
      messages.push({
        role: "system",
        content: `**${name}**${range} を表示`,
        stepIndex: absIndex,
        type,
        icon: "eye",
      });
    } else if (
      type === "CORTEX_STEP_TYPE_VIEW_FILE_OUTLINE" &&
      step.viewFileOutline
    ) {
      const uri = (step.viewFileOutline.absolutePathUri ?? "").replace(
        "file://",
        "",
      );
      const name = uri.split("/").pop() ?? uri;
      messages.push({
        role: "system",
        content: `**${name}** のアウトラインを確認`,
        stepIndex: absIndex,
        type,
        icon: "list",
      });
    } else if (
      type === "CORTEX_STEP_TYPE_VIEW_CODE_ITEM" &&
      step.viewCodeItem
    ) {
      const vci = step.viewCodeItem;
      const uri = (vci.absoluteUri ?? "").replace("file://", "");
      const name = uri.split("/").pop() ?? uri;
      const nodes = vci.nodePaths ?? [];
      messages.push({
        role: "system",
        content: `**${name}** を解析${nodes.length ? ` → ${nodes.join(", ")}` : ""}`,
        stepIndex: absIndex,
        type,
        icon: "file-search",
      });
    } else if (
      type === "CORTEX_STEP_TYPE_LIST_DIRECTORY" &&
      step.listDirectory
    ) {
      const ld = step.listDirectory;
      const uri = (ld.directoryPathUri ?? "").replace("file://", "");
      const name = uri.split("/").pop() ?? uri;
      const results = ld.results ?? [];
      messages.push({
        role: "system",
        content: `**${name}/** の一覧を取得 — ${results.length}件`,
        stepIndex: absIndex,
        type,
        icon: "folder",
      });
    } else if (type === "CORTEX_STEP_TYPE_FIND" && step.find) {
      const f = step.find;
      const pattern = f.pattern ?? "*";
      const results = f.results ?? [];
      messages.push({
        role: "system",
        content: `\`${pattern}\` を検索 — ${results.length}件`,
        stepIndex: absIndex,
        type,
        icon: "search",
      });
    } else if (type === "CORTEX_STEP_TYPE_ERROR_MESSAGE") {
      const errObj = step.errorMessage?.error;
      const errText =
        errObj?.userErrorMessage?.trim() ||
        errObj?.shortError?.trim() ||
        errObj?.fullError?.trim() ||
        "エージェント実行中にエラーが発生しました";
      messages.push({
        role: "system",
        content: `実行エラー: ${errText}`,
        stepIndex: absIndex,
        type,
        icon: "alert",
      });
    } else if (
      step.status === "CORTEX_STEP_STATUS_WAITING" ||
      Boolean(step.requestedInteraction)
    ) {
      // 将来の Antigravity 本体アップデートで未知の対話型ステップが増えても
      // 画面に何も出ず「止まったように見える」状態を防ぐ汎用フォールバック
      const toolLabel =
        step.metadata?.toolCall?.name ??
        type.replace(/^CORTEX_STEP_TYPE_/, "");
      messages.push({
        role: "system",
        content: `⏳ 確認・操作待ち（${toolLabel}）: Antigravity 本体からの応答待ちリクエストです。操作できない場合は Antigravity 本体ウィンドウ側でも確認できます。`,
        stepIndex: absIndex,
        type: "CORTEX_STEP_TYPE_GENERIC_WAITING",
        step,
        icon: "alert",
      });
    }
  }

  // Collapse consecutive text-only system messages (never merge error alerts)
  const collapsed: ChatMessage[] = [];
  for (const msg of messages) {
    const isAlert =
      msg.type === "CORTEX_STEP_TYPE_ERROR_MESSAGE" ||
      msg.type === "error" ||
      msg.icon === "alert";
    if (msg.role === "system" && !msg.step && !isAlert) {
      const prev = collapsed[collapsed.length - 1];
      const prevIsAlert =
        prev?.type === "CORTEX_STEP_TYPE_ERROR_MESSAGE" ||
        prev?.type === "error" ||
        prev?.icon === "alert";
      if (prev?.role === "system" && !prev.step && !prevIsAlert) {
        prev.content += "\n" + msg.content;
        continue;
      }
    }
    collapsed.push({ ...msg });
  }

  return collapsed;
}
