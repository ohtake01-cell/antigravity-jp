import type {
  AskQuestionRequest,
  FilePermissionRequest,
  PermissionRequest,
  TrajectoryStep,
} from "../types";

/** Permissions can be attached to any tool, including unknown step types. */
export function getPermissionRequest(
  step: TrajectoryStep,
): PermissionRequest | undefined {
  return step.requestedInteraction?.permission;
}

/**
 * Extract a filePermissionRequest from any of the tool data fields
 * where the LS may embed it, or from the step's top-level field.
 *
 * The LS embeds filePermissionRequest in 6 step types:
 * CodeAction, ViewFile, ListDirectory, GrepSearch, ViewFileOutline, ViewCodeItem.
 */
export function getFilePermissionRequest(
  step: TrajectoryStep,
): FilePermissionRequest | undefined {
  let fpr =
    step.filePermissionRequest ??
    step.viewFile?.filePermissionRequest ??
    step.listDirectory?.filePermissionRequest ??
    step.codeAction?.filePermissionRequest ??
    step.grepSearch?.filePermissionRequest ??
    step.viewFileOutline?.filePermissionRequest ??
    step.viewCodeItem?.filePermissionRequest;

  if (fpr) {
    fpr = {
      ...fpr,
      action:
        fpr.action ?? (step.codeAction ? "write_file" : "read_file"),
      responseKind: "filePermission",
    };
  }

  if (!fpr && step.requestedInteraction?.permission) {
    const perm = step.requestedInteraction.permission;
    if (
      perm.resource &&
      (perm.resource.action === "read_file" ||
        perm.resource.action === "write_file")
    ) {
      fpr = {
        absolutePathUri: perm.resource.target ?? "",
        isDirectory: false,
        action: perm.resource.action,
        responseKind: "permission",
      };
    }
  }

  return fpr;
}

function parseAskQuestionFromToolArgs(
  step: TrajectoryStep,
): AskQuestionRequest | undefined {
  const toolCall = step.metadata?.toolCall;
  if (
    step.type !== "CORTEX_STEP_TYPE_ASK_QUESTION" &&
    toolCall?.name !== "ask_question"
  ) {
    return undefined;
  }
  const rawArgs = toolCall?.argumentsJson;
  if (!rawArgs) return undefined;
  try {
    const parsed = JSON.parse(rawArgs) as {
      questions?: Array<{
        question?: string;
        options?: Array<string | { id?: string; text?: string }>;
        isMultiSelect?: boolean;
        is_multi_select?: boolean;
      }>;
    };
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      return undefined;
    }
    return {
      questions: parsed.questions.map((q) => ({
        question: q.question,
        isMultiSelect: q.isMultiSelect ?? q.is_multi_select ?? false,
        options: Array.isArray(q.options)
          ? q.options.map((opt, idx) =>
              typeof opt === "string"
                ? { id: String(idx + 1), text: opt }
                : { id: opt.id ?? String(idx + 1), text: opt.text ?? opt.id ?? "" },
            )
          : [],
      })),
    };
  } catch {
    return undefined;
  }
}

export function getAskQuestionRequest(
  step: TrajectoryStep,
): AskQuestionRequest | undefined {
  const direct = step.askQuestion ?? step.requestedInteraction?.askQuestion;
  if (direct?.questions && direct.questions.length > 0) {
    return direct;
  }
  return parseAskQuestionFromToolArgs(step);
}
