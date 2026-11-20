/**
 * Strips heavy unused binary/signature payloads and redundant unchanged diff context
 * from trajectory steps before sending them over HTTP or WebSocket to the web client.
 *
 * Keeps all fields rendered or inspected by the frontend:
 * - userInput (including user-attached media)
 * - plannerResponse (text, thinking, toolCalls id/name/argumentsJson)
 * - runCommand, codeAction (with -U3 context-compacted unifiedDiff), permission/askQuestion requests
 * - viewFile metadata (absolutePathUri, startLine, endLine, filePermissionRequest)
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripThinkingSignatureFromToolCall(toolCall: unknown): unknown {
  if (!isRecord(toolCall) || !("thinkingSignature" in toolCall)) {
    return toolCall;
  }
  const { thinkingSignature: _dropped, ...rest } = toolCall;
  return rest;
}

const MAX_UNCOMPACTED_DIFF_LINES = 60;
const DIFF_CONTEXT_RADIUS = 3;
const MAX_COMMAND_OUTPUT_CHARS = 80_000;

/**
 * Compact huge unifiedDiff.lines arrays (which Antigravity LS often emits with
 * the entire 2,000+ line file as UNCHANGED lines) down to git-style -U3 hunks.
 * Preserves 100% of INSERT/DELETE lines so +additions / -deletions counts stay exact.
 */
function compactUnifiedDiffLines(lines: unknown[]): unknown[] {
  if (lines.length <= MAX_UNCOMPACTED_DIFF_LINES) return lines;

  const isChange = (line: unknown): boolean => {
    if (!isRecord(line)) return false;
    const t = line.type;
    return (
      t === "UNIFIED_DIFF_LINE_TYPE_INSERT" ||
      t === "UNIFIED_DIFF_LINE_TYPE_DELETE"
    );
  };

  const keep = new Uint8Array(lines.length);
  let hasAnyChange = false;
  for (let i = 0; i < lines.length; i++) {
    if (isChange(lines[i])) {
      hasAnyChange = true;
      const start = Math.max(0, i - DIFF_CONTEXT_RADIUS);
      const end = Math.min(lines.length - 1, i + DIFF_CONTEXT_RADIUS);
      for (let j = start; j <= end; j++) keep[j] = 1;
    }
  }

  if (!hasAnyChange) {
    // No diff lines marked as change — keep compact head/tail preview
    return [
      ...lines.slice(0, 15),
      {
        type: "UNIFIED_DIFF_LINE_TYPE_UNCHANGED",
        text: `··· (${lines.length - 30} 行省略) ···`,
      },
      ...lines.slice(-15),
    ];
  }

  const out: unknown[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (skipped > 0) {
        out.push({
          type: "UNIFIED_DIFF_LINE_TYPE_UNCHANGED",
          text: `··· (${skipped} 行省略) ···`,
        });
        skipped = 0;
      }
      out.push(lines[i]);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    out.push({
      type: "UNIFIED_DIFF_LINE_TYPE_UNCHANGED",
      text: `··· (${skipped} 行省略) ···`,
    });
  }

  return out.length < lines.length ? out : lines;
}

function compactCodeAction(codeAction: Record<string, unknown>): Record<string, unknown> {
  const actionResult = codeAction.actionResult;
  if (!isRecord(actionResult)) return codeAction;
  const edit = actionResult.edit;
  if (!isRecord(edit)) return codeAction;
  const diff = edit.diff;
  if (!isRecord(diff)) return codeAction;
  const unifiedDiff = diff.unifiedDiff;
  if (!isRecord(unifiedDiff) || !Array.isArray(unifiedDiff.lines)) {
    return codeAction;
  }

  const compacted = compactUnifiedDiffLines(unifiedDiff.lines);
  if (compacted === unifiedDiff.lines) return codeAction;

  return {
    ...codeAction,
    actionResult: {
      ...actionResult,
      edit: {
        ...edit,
        diff: {
          ...diff,
          unifiedDiff: {
            ...unifiedDiff,
            lines: compacted,
          },
        },
      },
    },
  };
}

function compactRunCommand(runCommand: Record<string, unknown>): Record<string, unknown> {
  const combined = runCommand.combinedOutput;
  if (!isRecord(combined) || typeof combined.full !== "string") {
    return runCommand;
  }
  if (combined.full.length <= MAX_COMMAND_OUTPUT_CHARS) {
    return runCommand;
  }
  const head = combined.full.slice(0, 24_000);
  const tail = combined.full.slice(-40_000);
  const omitted = combined.full.length - 64_000;
  return {
    ...runCommand,
    combinedOutput: {
      ...combined,
      full: `${head}\n\n··· (${omitted.toLocaleString()} 文字省略) ···\n\n${tail}`,
    },
  };
}

export function sanitizeStepForClient(step: unknown): unknown {
  if (!isRecord(step)) return step;

  let next: Record<string, unknown> | null = null;
  const ensureCopy = () => {
    if (!next) next = { ...step };
    return next;
  };

  // VIEW_FILE steps can embed multi-megabyte mediaData (base64 videos/images)
  // and full file contents that the UI never renders (it only displays path/range
  // and any filePermissionRequest).
  if (isRecord(step.viewFile)) {
    const vf = step.viewFile;
    if ("mediaData" in vf || "content" in vf) {
      const { mediaData: _media, content: _content, ...lightViewFile } = vf;
      ensureCopy().viewFile = lightViewFile;
    }
  }

  // Compact massive unchanged file-body context inside CODE_ACTION diffs (240KB -> ~5KB)
  if (isRecord(step.codeAction)) {
    const compacted = compactCodeAction(step.codeAction);
    if (compacted !== step.codeAction) {
      ensureCopy().codeAction = compacted;
    }
  }

  // Cap runaway command output logs to prevent browser memory spikes
  if (isRecord(step.runCommand)) {
    const compacted = compactRunCommand(step.runCommand);
    if (compacted !== step.runCommand) {
      ensureCopy().runCommand = compacted;
    }
  }

  // Drop opaque model thinkingSignature blobs from toolCalls (hundreds of KB per chat).
  if (isRecord(step.metadata) && isRecord(step.metadata.toolCall)) {
    const cleaned = stripThinkingSignatureFromToolCall(step.metadata.toolCall);
    if (cleaned !== step.metadata.toolCall) {
      ensureCopy().metadata = {
        ...step.metadata,
        toolCall: cleaned,
      };
    }
  }

  if (
    isRecord(step.plannerResponse) &&
    Array.isArray(step.plannerResponse.toolCalls)
  ) {
    let changed = false;
    const cleanedToolCalls = step.plannerResponse.toolCalls.map((tc) => {
      const cleaned = stripThinkingSignatureFromToolCall(tc);
      if (cleaned !== tc) changed = true;
      return cleaned;
    });
    if (changed) {
      ensureCopy().plannerResponse = {
        ...step.plannerResponse,
        toolCalls: cleanedToolCalls,
      };
    }
  }

  return next ?? step;
}

export function sanitizeStepsForClient<T>(steps: T[]): T[] {
  return steps.map((step) => sanitizeStepForClient(step) as T);
}
