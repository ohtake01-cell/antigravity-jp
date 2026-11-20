/**
 * Strips heavy unused binary/signature payloads from trajectory steps before
 * sending them over HTTP or WebSocket to the web client.
 *
 * Keeps all fields rendered or inspected by the frontend:
 * - userInput (including user-attached media)
 * - plannerResponse (text, thinking, toolCalls id/name/argumentsJson)
 * - runCommand, codeAction, permission/askQuestion requests, subagent metadata
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
