const API_BASE = import.meta.env.VITE_API_BASE ?? "";

function previewBody(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 120) return singleLine;
  return `${singleLine.slice(0, 117)}...`;
}

function getTargetAppHeader(): string | undefined {
  try {
    const raw = localStorage.getItem("porta:settings");
    if (!raw) return undefined;
    const settings = JSON.parse(raw);
    if (settings.targetApp && settings.targetApp !== "all") {
      return settings.targetApp;
    }
  } catch {
    // Ignore error
  }
  return undefined;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs = 15_000,
): Promise<T> {
  const targetApp = getTargetAppHeader();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(targetApp ? { "x-porta-target-app": targetApp } : {}),
    ...((options.headers as Record<string, string>) ?? {}),
  };

  const controller = new AbortController();
  const externalSignal = options.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      ...options,
      signal: controller.signal,
      headers,
    });
  } catch (err) {
    if (timedOut) {
      throw new Error(`API timeout after ${timeoutMs}ms for ${path}`);
    }
    throw err;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }

  if (!res.ok) {
    const body = await res.text();
    let msg: string;
    try {
      msg = JSON.parse(body).error ?? body;
    } catch {
      msg = body;
    }
    throw new Error(`API ${res.status}: ${msg}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    const body = previewBody(await res.text());
    throw new Error(
      `API returned non-JSON for ${path}: ${body || "<empty response>"}`,
    );
  }

  return res.json();
}

export const api = {
  health: () =>
    request<import("../types").HealthResponse>("/api/health", {}, 5_000),

  conversations: () =>
    request<import("../types").ConversationsResponse>("/api/conversations"),

  archivedConversations: () =>
    request<import("../types").ConversationsResponse>(
      "/api/conversations/archived",
    ),

  getConversation: (cascadeId: string) =>
    request<import("../types").ConversationDetail>(
      `/api/conversations/${cascadeId}`,
    ),

  conversationAgents: (cascadeId: string) =>
    request<import("../types").ConversationAgentsResponse>(
      `/api/conversations/${cascadeId}/agents`,
    ),

  /** Fetch steps with optional limit or tail. Returns { steps, offset, stepCount? }. */
  getSteps: (cascadeId: string, offset?: number, limit?: number, tail?: number) => {
    const params = new URLSearchParams();
    if (offset !== undefined) params.set("offset", String(offset));
    if (limit !== undefined) params.set("limit", String(limit));
    if (tail !== undefined) params.set("tail", String(tail));
    return request<import("../types").StepsPageResponse>(
      `/api/conversations/${cascadeId}/steps?${params}`,
    );
  },

  getWorkspaces: () =>
    request<{
      workspaceInfos?: { workspaceUri: string; gitRootUri?: string }[];
    }>("/api/workspaces"),

  projects: () =>
    request<{ projects: import("../types").ProjectEntry[] }>("/api/projects"),

  createProject: (payload: { name?: string; folderPath?: string }) =>
    request<{ project: import("../types").ProjectEntry }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  deleteProject: (id: string) =>
    request<{ ok: boolean; id: string }>(
      `/api/projects/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),

  startConversation: (
    workspaceUri?: string,
    fileAccessGranted = false,
    projectId?: string,
  ) =>
    request<{ cascadeId: string }>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({
        ...(workspaceUri ? { workspaceFolderAbsoluteUri: workspaceUri } : {}),
        ...(projectId ? { projectId } : {}),
        fileAccessGranted,
      }),
    }),

  sendMessage: (
    cascadeId: string,
    items: unknown[],
    clientMessageId?: string,
    model?: string,
    media?: Array<{ mimeType: string; inlineData: string }>,
    plannerType?: string,
    fileAccessGranted = false,
    autoExecutionPolicy?: import("../types").LocalPermissionPolicy,
  ) =>
    request(
      `/api/conversations/${cascadeId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          items,
          clientMessageId,
          model,
          media,
          plannerType,
          fileAccessGranted,
          ...(autoExecutionPolicy ? { autoExecutionPolicy } : {}),
        }),
      },
      60_000,
    ),

  stop: (cascadeId: string) =>
    request(`/api/conversations/${cascadeId}/stop`, { method: "POST" }),

  filePermission: (
    cascadeId: string,
    trajectoryId: string,
    stepIndex: number,
    allow: boolean,
    scope: number,
    absolutePathUri: string,
  ) =>
    request(`/api/conversations/${cascadeId}/file-permission`, {
      method: "POST",
      body: JSON.stringify({
        trajectoryId,
        stepIndex,
        allow,
        scope,
        absolutePathUri,
      }),
    }),

  commandAction: (
    cascadeId: string,
    trajectoryId: string,
    stepIndex: number,
    approved: boolean,
  ) =>
    request(`/api/conversations/${cascadeId}/command-action`, {
      method: "POST",
      body: JSON.stringify({
        trajectoryId,
        stepIndex,
        approved,
      }),
    }),

  askQuestion: (
    cascadeId: string,
    trajectoryId: string,
    stepIndex: number,
    responses: import("../types").AskQuestionEntry[],
    cancelled = false,
  ) =>
    request(`/api/conversations/${cascadeId}/ask-question`, {
      method: "POST",
      body: JSON.stringify({
        trajectoryId,
        stepIndex,
        responses,
        cancelled,
      }),
    }),

  revert: (cascadeId: string, stepIndex: number, model?: string) =>
    request(`/api/conversations/${cascadeId}/revert`, {
      method: "POST",
      body: JSON.stringify({ stepIndex, model }),
    }),

  deleteConversation: (cascadeId: string) =>
    request(`/api/conversations/${cascadeId}`, { method: "DELETE" }),

  renameConversation: (cascadeId: string, title: string) =>
    request<{ ok: boolean; id: string; title: string }>(
      `/api/conversations/${cascadeId}/title`,
      {
        method: "PATCH",
        body: JSON.stringify({ title }),
      },
    ),

  updateAnnotations: (
    cascadeId: string,
    patch: { title?: string; archived?: boolean; pinned?: boolean },
  ) =>
    request<{
      ok: boolean;
      id: string;
      title?: string;
      archived?: boolean;
      pinned?: boolean;
    }>(`/api/conversations/${cascadeId}/annotations`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  models: () =>
    request<{
      clientModelConfigs: Array<{
        label: string;
        modelOrAlias: { model: string };
        supportsImages: boolean;
        isRecommended: boolean;
        tagTitle?: string;
        tagDescription?: string;
        quotaInfo?: {
          remainingFraction: number;
          resetTime?: string;
        };
      }>;
      defaultOverrideModelConfig?: { modelOrAlias: { model: string } };
    }>("/api/models"),

  modelCatalog: (refresh = false) =>
    request<import("../types").ModelCatalogResponse>(
      `/api/models/catalog${refresh ? "?refresh=1" : ""}`,
    ),

  weeklyUsage: (refresh = false) =>
    request<import("../types").WeeklyUsageResponse>(
      `/api/usage/weekly${refresh ? "?refresh=1" : ""}`,
    ),

  // ── Command / Extensions ──

  commandOverview: (refresh = false) =>
    request<import("../types").CommandOverviewResponse>(
      `/api/command/overview${refresh ? "?refresh=1" : ""}`,
    ),

  commandSessions: () =>
    request<{ sessions: import("../types").WorkerSessionDetail[] }>(
      "/api/command/sessions",
    ),

  commandSessionDetail: (id: string) =>
    request<{ session: import("../types").WorkerSessionDetail }>(
      `/api/command/sessions/${encodeURIComponent(id)}`,
    ),

  commandCreateSession: (payload: {
    provider: Exclude<import("../types").ProviderId, "antigravity">;
    prompt: string;
    title?: string;
    roleLabel?: string;
    model?: string;
    effort?: import("../types").EffortLevel;
    workspaceDir?: string;
    executionMode?: "work" | "chat";
    autoRelay?: boolean;
  }) =>
    request<{
      ok: boolean;
      session: import("../types").WorkerSessionDetail;
      requiresApproval?: boolean;
    }>("/api/command/sessions", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  commandSendSession: (
    id: string,
    payload: {
      prompt: string;
      model?: string;
      effort?: import("../types").EffortLevel;
      executionMode?: "work" | "chat";
    },
  ) =>
    request<{
      ok: boolean;
      session: import("../types").WorkerSessionDetail;
      requiresApproval?: boolean;
    }>(`/api/command/sessions/${encodeURIComponent(id)}/send`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  commandStopSession: (id: string) =>
    request<{ ok: boolean; session?: import("../types").WorkerSessionDetail }>(
      `/api/command/sessions/${encodeURIComponent(id)}/stop`,
      { method: "POST" },
    ),

  commandCloseSession: (id: string) =>
    request<{ ok: boolean; session?: import("../types").WorkerSessionDetail }>(
      `/api/command/sessions/${encodeURIComponent(id)}/close`,
      { method: "POST" },
    ),

  commandHandoffSession: (
    id: string,
    payload: {
      targetProvider: import("../types").ProviderId;
      targetModel?: string;
      targetEffort?: import("../types").EffortLevel;
      note?: string;
      workspaceUri?: string;
    },
  ) =>
    request<
      | {
          ok: true;
          targetKind: "antigravity";
          targetId: string;
          resolvedModel?: string | null;
          warning?: string | null;
        }
      | {
          ok: true;
          targetKind: "worker_session";
          targetId: string;
          session: import("../types").WorkerSessionDetail;
          warning?: string | null;
        }
    >(`/api/command/sessions/${encodeURIComponent(id)}/handoff`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  commandCreateAntigravity: (payload: {
    prompt?: string;
    model?: string;
    effort?: import("../types").EffortLevel;
    workspaceUri?: string;
    title?: string;
    plannerType?: "conversational" | "planning";
  }) =>
    request<{
      ok: true;
      cascadeId: string;
      resolvedModel?: string | null;
    }>("/api/command/antigravity/create", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  commandSendAntigravity: (
    id: string,
    payload: {
      prompt: string;
      model?: string;
      effort?: import("../types").EffortLevel;
      plannerType?: "conversational" | "planning";
    },
  ) =>
    request<{ ok: boolean }>(
      `/api/command/antigravity/${encodeURIComponent(id)}/send`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),

  commandStopAntigravity: (id: string) =>
    request<{ ok: boolean }>(
      `/api/command/antigravity/${encodeURIComponent(id)}/stop`,
      { method: "POST" },
    ),

  commandCloseAntigravity: (id: string) =>
    request<{ ok: boolean }>(
      `/api/command/antigravity/${encodeURIComponent(id)}/close`,
      { method: "POST" },
    ),

  commandRecommend: (task: string) =>
    request<import("../types").CommandRecommendResponse>(
      "/api/command/recommend",
      {
        method: "POST",
        body: JSON.stringify({ task }),
      },
    ),

  commandSupervisor: () =>
    request<{
      ok?: boolean;
      supervisor: import("../types").SupervisorState;
    }>("/api/command/supervisor"),

  commandUpdateSupervisor: (payload: {
    enabled?: boolean;
    autoRelay?: boolean;
    hangTimeoutSec?: number;
  }) =>
    request<{
      ok?: boolean;
      supervisor: import("../types").SupervisorState;
    }>("/api/command/supervisor", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  commandOpenExternalApp: () =>
    request<{ ok: true; appPath: string }>("/api/command/muse/open", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  commandApprovals: (pendingOnly = false) =>
    request<{
      ok: boolean;
      approvals: import("../types").CommandApprovalItem[];
    }>(`/api/command/approvals${pendingOnly ? "?pendingOnly=1" : ""}`),

  commandCreateApproval: (payload: {
    kind?: import("../types").ApprovalKind;
    provider: import("../types").ProviderId;
    sessionId?: string | null;
    title: string;
    summary: string;
    target?: string | null;
    editablePayload?: string | null;
  }) =>
    request<{ ok: boolean; approval: import("../types").CommandApprovalItem }>(
      "/api/command/approvals",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),

   commandDecideApproval: (
    id: string,
    payload: {
      decision: "approved" | "rejected";
      scope?: import("../types").ApprovalScope;
      editedPayload?: string;
      note?: string;
    },
  ) =>
    request<{
      ok: boolean;
      approval: import("../types").CommandApprovalItem;
      resumedSession?: import("../types").WorkerSessionDetail | null;
    }>(
      `/api/command/approvals/${encodeURIComponent(id)}/decide`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),

  commandCreateSideChat: (payload: {
    sourceKind: "antigravity" | "worker_session";
    sourceId: string;
    sourceTitle?: string;
    contextSnippet?: string;
    targetProvider: import("../types").ProviderId;
    targetModel?: string;
    effort?: import("../types").EffortLevel;
    workspaceDir?: string;
    workspaceUri?: string;
    prompt: string;
  }) =>
    request<
      | {
          ok: true;
          targetKind: "antigravity";
          targetId: string;
          resolvedModel?: string | null;
        }
      | {
          ok: true;
          targetKind: "worker_session";
          targetId: string;
          session: import("../types").WorkerSessionDetail;
        }
    >("/api/command/side-chat", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  readWorkbenchFile: (fileRef: string) =>
    request<import("../types").WorkbenchReadResponse>(
      `/api/files/read?${fileRef.startsWith("file://") ? `uri=${encodeURIComponent(fileRef)}` : `path=${encodeURIComponent(fileRef)}`}`,
    ),

  writeWorkbenchFile: (path: string, content: string) =>
    request<{
      ok: true;
      path: string;
      bytesWritten: number;
      mtime: string;
    }>("/api/files/write", {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    }),

  recentWorkbenchFiles: (workspace?: string | null) =>
    request<{
      ok: true;
      files: import("../types").WorkbenchRecentFileItem[];
    }>(
      `/api/files/recent${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`,
    ),

  commandSafety: () =>
    request<{
      ok: boolean;
      safetyPolicy: import("../types").CommandSafetyPolicy;
    }>("/api/command/safety"),

  commandUpdateSafety: (payload: {
    blockedFolders?: string[];
    blockedApps?: string[];
    keepAwakeWhileRunning?: boolean;
  }) =>
    request<{
      ok: boolean;
      safetyPolicy: import("../types").CommandSafetyPolicy;
    }>("/api/command/safety", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  commandBrainHub: () =>
    request<import("../types").BrainHubResponse>("/api/command/brain-hub"),

  commandCreateGoal: (payload: {
    title: string;
    description?: string;
    preferredProvider?: import("../types").ProviderId | null;
    progressPercent?: number;
    nextAction?: string;
  }) =>
    request<{ ok: boolean; goal: import("../types").CommandGoalItem }>(
      "/api/command/goals",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),

  commandUpdateGoal: (
    id: string,
    payload: {
      title?: string;
      description?: string;
      status?: "active" | "completed" | "paused";
      preferredProvider?: import("../types").ProviderId | null;
      progressPercent?: number;
      nextAction?: string;
    },
  ) =>
    request<{ ok: boolean; goal: import("../types").CommandGoalItem }>(
      `/api/command/goals/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    ),

  commandDeleteGoal: (id: string) =>
    request<{ ok: boolean; id: string }>(
      `/api/command/goals/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
      },
    ),

  commandMemories: (params?: {
    q?: string;
    category?: import("../types").MemoryCategory;
  }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.category) qs.set("category", params.category);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{
      ok: boolean;
      memories: import("../types").StructuredMemoryItem[];
    }>(`/api/command/memories${suffix}`);
  },

  commandCreateMemory: (payload: {
    category?: import("../types").MemoryCategory;
    title: string;
    content: string;
    pinned?: boolean;
    enabled?: boolean;
  }) =>
    request<{
      ok: boolean;
      memory: import("../types").StructuredMemoryItem;
    }>("/api/command/memories", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  commandUpdateMemory: (
    id: string,
    payload: {
      category?: import("../types").MemoryCategory;
      title?: string;
      content?: string;
      pinned?: boolean;
      enabled?: boolean;
    },
  ) =>
    request<{
      ok: boolean;
      memory: import("../types").StructuredMemoryItem;
    }>(`/api/command/memories/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  commandDeleteMemory: (id: string) =>
    request<{ ok: boolean; id: string }>(
      `/api/command/memories/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),

  commandConnectors: () =>
    request<{
      ok: boolean;
      connectors: import("../types").LocalConnectorConfig[];
    }>("/api/command/connectors"),

  commandUpdateConnector: (
    appId: import("../types").LocalAppId,
    payload: {
      syncMode?: import("../types").LocalSyncMode;
      maxItems?: number;
    },
  ) =>
    request<{
      ok: boolean;
      connector: import("../types").LocalConnectorConfig;
    }>(`/api/command/connectors/${encodeURIComponent(appId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  commandFetchConnector: (appId: import("../types").LocalAppId) =>
    request<{
      ok: boolean;
      connector: import("../types").LocalConnectorConfig;
      items: import("../types").LocalConnectorEntry[];
    }>(`/api/command/connectors/${encodeURIComponent(appId)}/fetch`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  rpc: (method: string, body: Record<string, unknown> = {}) =>
    request(`/api/rpc/${method}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  search: (query: string) =>
    request<{
      query: string;
      results: {
        id: string;
        title: string;
        snippets: string[];
        matchCount: number;
        modelLabel?: string;
        modelProvider?: "google" | "anthropic" | "openai" | "ollama";
      }[];
      totalConversations: number;
      elapsedMs: number;
    }>(`/api/search?q=${encodeURIComponent(query)}`),

  transcribeVoice: async (
    audioBlob: Blob,
    filename = "voice.webm",
    language = "ja",
  ): Promise<{ text: string; elapsedMs: number }> => {
    const fd = new FormData();
    fd.append("file", audioBlob, filename);
    fd.append("language", language);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/voice/transcribe`, {
        method: "POST",
        body: fd,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text();
      let msg: string;
      try {
        msg = JSON.parse(body).error ?? body;
      } catch {
        msg = body;
      }
      throw new Error(msg || `API ${res.status}`);
    }
    return res.json();
  },

  getJpRule: () =>
    request<{
      installed: boolean;
      fileExists: boolean;
      path: string;
      error?: string;
    }>("/api/jp-rule"),

  installJpRule: () =>
    request<{
      ok: boolean;
      alreadyInstalled?: boolean;
      path?: string;
      backupPath?: string | null;
      error?: string;
    }>("/api/jp-rule", { method: "POST" }),
};
