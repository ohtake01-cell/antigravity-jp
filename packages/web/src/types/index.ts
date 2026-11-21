export interface SubagentChildSummary {
  id: string;
  role: string;
  typeName: string;
  status: string;
  lastModifiedTime: string;
  stepCount?: number;
  model?: string;
  modelLabel?: string;
  modelProvider?: "google" | "anthropic" | "openai" | "ollama";
}

export interface ActiveBackgroundTaskSummary {
  id: string;
  sizeBytes: number;
  updatedAt: string;
  isActive: boolean;
}

export interface ConversationSummary {
  summary: string;
  stepCount: number;
  lastModifiedTime: string;
  trajectoryId: string;
  status: string;
  createdTime: string;
  workspaces: Workspace[];
  lastUserInputTime?: string;
  lastUserInputStepIndex?: number;
  projectName?: string;
  assignedProjectId?: string;
  model?: string;
  modelLabel?: string;
  modelProvider?: "google" | "anthropic" | "openai" | "ollama";
  subagents?: SubagentChildSummary[];
  hasRunningSubagent?: boolean;
  activeTasks?: ActiveBackgroundTaskSummary[];
  taskCount?: number;
  annotations?: {
    archived?: boolean;
    title?: string;
    pinned?: boolean;
    [key: string]: unknown;
  };
  trajectoryMetadata?: {
    customTitle?: string;
    title?: string;
    parentConversationId?: string;
    subagentSpec?: unknown;
    nestingDepth?: number;
    [key: string]: unknown;
  };
}

export interface MediaAttachment {
  mimeType: string;
  inlineData: string; // base64 encoded
}

export interface Workspace {
  workspaceFolderAbsoluteUri?: string;
  gitRootAbsoluteUri?: string;
  repository?: {
    computedName?: string;
    gitOriginUrl?: string;
  };
  branchName?: string;
}

export interface ConversationsResponse {
  trajectorySummaries: Record<string, ConversationSummary>;
}

export interface ConversationDetail {
  status?: string;
  numTotalSteps?: number;
}

export interface HealthResponse {
  status: string;
  proxy: { port: number; uptime: number };
  languageServers: {
    pid: number;
    httpsPort: number;
    workspaceId?: string;
    appDataDir?: string;
    source: string;
  }[];
}

export type ConversationStatus =
  | "CASCADE_RUN_STATUS_IDLE"
  | "CASCADE_RUN_STATUS_RUNNING"
  | "CASCADE_RUN_STATUS_ERROR";

// ── File Permission ──

export interface FilePermissionRequest {
  absolutePathUri: string;
  blockReason?: string;
  isDirectory?: boolean;
  action?: string;
  /** Response field expected by HandleCascadeUserInteraction. */
  responseKind?: "filePermission" | "permission";
}

// ── Ask Question ──

export interface AskQuestionOption {
  id?: string;
  text?: string;
}

export interface AskQuestionEntry {
  question?: string;
  options?: AskQuestionOption[];
  isMultiSelect?: boolean;
  selectedOptionIds?: string[];
  writeInResponse?: string;
  skipped?: boolean;
}

export interface AskQuestionRequest {
  questions?: AskQuestionEntry[];
}

export interface AskQuestionInteraction {
  responses?: AskQuestionEntry[];
  cancelled?: boolean;
}

export interface PermissionRequest {
  resource?: {
    action?: string;
    target?: string;
  };
  triggerSource?: { type?: string; detail?: string };
}

export interface RequestedInteractionData {
  askQuestion?: AskQuestionRequest;
  permission?: PermissionRequest;
}

export interface CompletedInteractionData {
  request?: RequestedInteractionData;
  response?: {
    askQuestion?: AskQuestionInteraction;
  };
}

// ── Trajectory Steps ──

export interface StepsResponse {
  steps: TrajectoryStep[];
}

/** Paginated steps response from GET /steps (includes offset + total) */
export interface StepsPageResponse {
  steps: TrajectoryStep[];
  offset: number;
  stepCount?: number;
}

export interface TrajectoryStep {
  type: string;
  clientMessageId?: string;
  status?: string;
  metadata?: StepMetadata;
  userInput?: { items: StepItem[]; media?: unknown[] };
  systemMessage?: { message?: string };
  plannerResponse?: PlannerResponseData;
  invokeSubagent?: InvokeSubagentData;
  runCommand?: RunCommandData;
  codeAction?: CodeActionData;
  commandStatus?: CommandStatusData;
  sendCommandInput?: SendCommandInputData;
  grepSearch?: GrepSearchData;
  viewFile?: ViewFileData;
  viewFileOutline?: ViewFileOutlineData;
  viewCodeItem?: ViewCodeItemData;
  listDirectory?: ListDirectoryData;
  find?: FindData;
  generic?: { args?: Record<string, unknown> };
  askQuestion?: AskQuestionRequest;
  requestedInteraction?: RequestedInteractionData;
  completedInteractions?: CompletedInteractionData[];
  /** Error step emitted when agent execution fails on the LS */
  errorMessage?: {
    error?: {
      userErrorMessage?: string;
      shortError?: string;
      fullError?: string;
    };
  };
  /** File permission request can appear on any tool step */
  filePermissionRequest?: FilePermissionRequest;
}

export interface PlannerResponseData {
  items?: StepItem[];
  modifiedResponse?: string;
  thinking?: string;
  thinkingDuration?: string;
  toolCalls?: ToolCallData[];
}

export interface ToolCallData {
  id?: string;
  name?: string;
  argumentsJson?: string;
}

export interface StepMetadata {
  createdAt?: string;
  completedAt?: string;
  source?: string;
  executionId?: string;
  toolCall?: ToolCallData;
  toolSummary?: string;
  toolAction?: string;
  sourceTrajectoryStepInfo?: {
    trajectoryId?: string;
    stepIndex?: number;
  };
}

export interface NativeSubagentSpec {
  typeName?: string;
  role?: string;
  initialPrompt?: string;
  model?: string;
  modelTier?: string;
}

export interface SubagentResult {
  conversationId?: string;
  logAbsoluteUri?: string;
  workspaceUris?: string[];
}

/** Native payload of CORTEX_STEP_TYPE_INVOKE_SUBAGENT. */
export interface InvokeSubagentData {
  subagents?: NativeSubagentSpec[];
  taskMode?: boolean;
  results?: SubagentResult[];
  /** Legacy single-subagent fields retained by the AG protocol. */
  subagentName?: string;
  prompt?: string;
  conversationId?: string;
}

export interface RunCommandData {
  command?: string;
  commandLine?: string;
  commandId?: string;
  proposedCommandLine?: string;
  cwd?: string;
  blocking?: boolean;
  exitCode?: number;
  output?: string;
  combinedOutput?: {
    full?: string;
  };
}

export interface CommandStatusData {
  commandId?: string;
  status?: string;
  combined?: string;
}

export interface SendCommandInputData {
  terminate?: boolean;
}

export interface GrepSearchData {
  query?: string;
  results?: unknown[];
  searchPathUri?: string;
  filePermissionRequest?: FilePermissionRequest;
}

export interface ViewFileData {
  absolutePathUri?: string;
  startLine?: number;
  endLine?: number;
  filePermissionRequest?: FilePermissionRequest;
}

export interface ViewFileOutlineData {
  absolutePathUri?: string;
  filePermissionRequest?: FilePermissionRequest;
}

export interface ViewCodeItemData {
  absoluteUri?: string;
  nodePaths?: string[];
  filePermissionRequest?: FilePermissionRequest;
}

export interface ListDirectoryData {
  directoryPathUri?: string;
  results?: unknown[];
  filePermissionRequest?: FilePermissionRequest;
}

export interface FindData {
  pattern?: string;
  results?: unknown[];
}

export interface CodeActionData {
  description?: string;
  markdownLanguage?: string;
  actionSpec?: {
    createFile?: { path?: { absoluteUri?: string } };
  };
  actionResult?: {
    edit?: {
      absoluteUri?: string;
      createFile?: boolean;
      diff?: {
        unifiedDiff?: {
          lines?: DiffLine[];
        };
      };
    };
  };
  replacementInfos?: unknown[];
  filePermissionRequest?: FilePermissionRequest;
}

export interface DiffLine {
  text?: string;
  type:
    | "UNIFIED_DIFF_LINE_TYPE_UNCHANGED"
    | "UNIFIED_DIFF_LINE_TYPE_INSERT"
    | "UNIFIED_DIFF_LINE_TYPE_DELETE"
    | "UNIFIED_DIFF_LINE_TYPE_HUNK_HEADER";
}

export interface StepItem {
  text?: string;
}

export type SubagentToolKind = "invoke" | "define" | "manage" | "message";

export interface SubagentDisplayDetail {
  label: string;
  text: string;
}

export interface SubagentDisplayItem {
  role: string;
  typeName: string;
  model?: string;
  conversationId?: string;
  details: SubagentDisplayDetail[];
}

/** Sanitized, tool-independent data consumed by SubagentCard. */
export interface SubagentDisplayData {
  toolName: string;
  kind: SubagentToolKind;
  title: string;
  action?: string;
  items: SubagentDisplayItem[];
}

/** Normalized message for display */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  stepIndex: number;
  type: string;
  /** Original step data for rich rendering */
  step?: TrajectoryStep;
  /** Normalized subagent data for rich rendering */
  subagent?: SubagentDisplayData;
  /** Media attachments (images/video) */
  media?: unknown[];
  /** Extended thinking / chain-of-thought content */
  thinking?: string;
  /** Duration string e.g. "4.739s" */
  thinkingDuration?: string;
  /** Icon key for system messages */
  icon?: string;
  /** Stable client-side identity for optimistic messages */
  optimisticId?: string;
  /** Local-only optimistic lifecycle state */
  optimisticState?: "unconfirmed" | "failed";
}

export type TargetApp = "all" | "antigravity" | "antigravity-ide";

export type AppIconPreset =
  | "option1_official_orb"
  | "option2_neural_horizon"
  | "option3_starry_owl"
  | "option4_minimal_n";

// ── Client Settings ──

export type LocalPermissionPolicy =
  | "CASCADE_COMMANDS_AUTO_EXECUTION_OFF"
  | "CASCADE_COMMANDS_AUTO_EXECUTION_PROCEED_IN_SANDBOX"
  | "CASCADE_COMMANDS_AUTO_EXECUTION_AUTO"
  | "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER";

export type LocalPermissionMode = "request_review" | "default" | "auto" | "turbo";

export interface ProjectEntry {
  id: string;
  name: string;
  folderUri?: string;
  folderPath?: string;
  instructions?: string;
  isDefaultCli?: boolean;
}

export interface ProjectSettings {
  defaultProjectFolder: string;
  createProjectSubfolder: boolean;
}

export type AppTier = "lite" | "pro";

export type ExternalProviderId = "openai" | "anthropic" | "ollama";
export type UnifiedProviderId = "google" | ExternalProviderId;

export interface ProviderModelItem {
  id: string;
  label: string;
}

export interface ProviderAccountInfo {
  id: UnifiedProviderId;
  name: string;
  company: string;
  description: string;
  status: "ready" | "needs_login" | "not_installed" | "offline";
  installed: boolean;
  authenticated: boolean;
  accountHint?: string | null;
  activeModel?: string | null;
  models: ProviderModelItem[];
  supportsOfficialLogin: boolean;
  loginCommand?: string;
  installCommand?: string;
  loginHint?: string;
}

export interface ProvidersResponse {
  updatedAt: string;
  providers: ProviderAccountInfo[];
  extensions?: Array<{
    id: string;
    name: string;
    description?: string;
    url?: string;
    enabled?: boolean;
  }>;
}

export interface MultiAIMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  elapsedMs?: number;
  error?: boolean;
}

export interface MultiAISession {
  id: string;
  provider: ExternalProviderId;
  title: string;
  model: string | null;
  status: "idle" | "running" | "error";
  compareGroupId?: string;
  workspaceDir?: string;
  sourceChatId?: string;
  sourceChatTitle?: string;
  createdAt: string;
  updatedAt: string;
  messages: MultiAIMessage[];
}

export type ThemeMode = "dark" | "light" | "auto";

export interface ClientSettings {
  /** Model ID used when the user hasn't explicitly picked one per-message. */
  defaultModel: string | null;
  /** Planner type used when the user hasn't explicitly picked one per-message. */
  defaultPlannerType: "auto" | "conversational" | "planning";
  /** Command auto-execution policy (Local Permissions). */
  localPermissionPolicy?: LocalPermissionPolicy;
  /** One-time migration marker so existing clients adopt "auto" as default once. */
  plannerModeAutoMigrated?: boolean;
  /** Enables browser notifications for run completion and approval requests. */
  browserNotificationsEnabled: boolean;
  /** Target application engine filter (antigravity vs antigravity-ide vs all). */
  targetApp: TargetApp;
  /** App edition tier: "lite" (Gemini-only simple) vs "pro" (Multi-AI + provider logins). */
  appTier?: AppTier;
  /** User-selected app icon preset. */
  appIconPreset?: AppIconPreset;
  /** Appearance theme mode: dark, light, or auto (follows OS). */
  themeMode?: ThemeMode;
}

export interface AgentWeeklyBucket {
  active_tokens: number;
  uncached_input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  gross_tokens: number;
  conversations: number;
  weekly_quota?: {
    used_percent?: number | null;
    remaining_percent?: number | null;
    resets_at_iso?: string | null;
    observed_at?: string | null;
    status_note?: string | null;
  } | null;
}

export interface WeeklyDailyEntry {
  date: string;
  label: string;
  gear_active: number;
  codex_active: number;
  code_active: number;
  total_active: number;
  gear_gross: number;
  total_gross: number;
}

export interface WeeklyUsageResponse {
  updated_at: string;
  window: {
    start_date: string;
    end_date: string;
    days: number;
  };
  gear: AgentWeeklyBucket;
  codex: AgentWeeklyBucket;
  code: AgentWeeklyBucket;
  combined: {
    active_tokens: number;
    gross_tokens: number;
  };
  daily: WeeklyDailyEntry[];
}

export interface DiscoveredProviderModel {
  id: string;
  label: string;
  description?: string;
  isNew?: boolean;
  selectableInChat?: boolean;
  source: string;
}

export interface ProviderModelGroup {
  provider: "google" | "openai" | "anthropic";
  displayName: string;
  activeModelId: string | null;
  activeModelLabel: string | null;
  syncedAt: string | null;
  models: DiscoveredProviderModel[];
}

export interface ModelCatalogResponse {
  updatedAt: string;
  providers: {
    google: ProviderModelGroup;
    openai: ProviderModelGroup;
    anthropic: ProviderModelGroup;
  };
}

// ── Provider & Session Types ──

export type ProviderId =
  | "antigravity"
  | "codex"
  | "ollama"
  | "claude";

export type EffortLevel = "low" | "medium" | "high" | "xhigh";

export type ProviderHealthStatus =
  | "ready"
  | "busy"
  | "warning"
  | "limited"
  | "offline"
  | "unsubscribed";

export type CommandProviderTier = "commander" | "specialist" | "local_zero";

export interface CommandProviderModel {
  id: string;
  label: string;
  tags?: string[];
  remainingPercent?: number | null;
  resetAt?: string | null;
  loaded?: boolean;
}

export interface CommandProviderCard {
  id: ProviderId;
  name: string;
  roleLabel: string;
  tier: CommandProviderTier;
  status: ProviderHealthStatus;
  statusLabel: string;
  available: boolean;
  remainingPercent: number | null;
  quotaLabel: string;
  resetAt: string | null;
  recommendedModel: string | null;
  recommendedModelLabel?: string | null;
  activeCount: number;
  runningCount: number;
  models: CommandProviderModel[];
  loadedModels?: string[];
  endpoint?: string | null;
  detail?: string | null;
}

export interface CommandAlert {
  id: string;
  severity: "info" | "warning" | "critical";
  provider?: ProviderId;
  sessionId?: string;
  title: string;
  message: string;
  suggestedAction?: string;
  createdAt: string;
}

export interface CommandSessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  model?: string | null;
  effort?: EffortLevel | null;
}

export interface CommandSessionLog {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface CommandChatItem {
  id: string;
  kind: "antigravity" | "worker_session";
  provider: ProviderId;
  title: string;
  roleLabel?: string;
  status: "running" | "idle" | "error" | "archived" | "unloaded";
  model: string | null;
  modelLabel?: string | null;
  effort?: EffortLevel | null;
  liveStatus?: string | null;
  autoRelay?: boolean;
  workspaceUri?: string | null;
  workspaceDir?: string | null;
  updatedAt: string;
  createdAt?: string;
  lastMessagePreview?: string;
  messageCount?: number;
  stepCount?: number;
  handoffFrom?: string | null;
  isSideChat?: boolean;
  parentSessionId?: string | null;
  pendingApprovalId?: string | null;
  subagents?: SubagentChildSummary[];
  hasRunningSubagent?: boolean;
}

export interface WorkerSessionRelayedTo {
  targetKind: "antigravity" | "worker_session";
  targetId: string;
  reason: string;
  at: string;
}

export interface WorkerSessionDetail {
  id: string;
  provider: Exclude<ProviderId, "antigravity">;
  title: string;
  roleLabel: string;
  model: string | null;
  effort: EffortLevel;
  executionMode: "work" | "chat";
  workspaceDir: string;
  status: "running" | "idle" | "error" | "archived";
  createdAt: string;
  updatedAt: string;
  lastLogAt: string;
  pid?: number | null;
  handoffFrom?: string | null;
  lastError?: string | null;
  liveStatus?: string | null;
  streamingContent?: string | null;
  autoRelay?: boolean;
  relayedTo?: WorkerSessionRelayedTo | null;
  needsAttention?: boolean;
  isSideChat?: boolean;
  parentSessionId?: string | null;
  pendingApprovalId?: string | null;
  messages: CommandSessionMessage[];
  logs: CommandSessionLog[];
}

export interface SupervisorEvent {
  id: string;
  at: string;
  kind?: string;
  severity?: "info" | "warning" | "critical";
  sessionId?: string;
  provider?: ProviderId;
  title?: string;
  message: string;
  targetKind?: "antigravity" | "worker_session";
  targetId?: string;
}

export interface SupervisorState {
  enabled: boolean;
  autoRelay: boolean;
  hangTimeoutSec: number;
  lastSweepAt: string | null;
  events: SupervisorEvent[];
}

export type ApprovalKind =
  | "external_send"
  | "file_delete"
  | "exec_command"
  | "api_cost"
  | "custom";

export type ApprovalScope = "once" | "task" | "always_target";

export interface CommandApprovalItem {
  id: string;
  kind: ApprovalKind;
  provider: ProviderId;
  sessionId?: string | null;
  title: string;
  summary: string;
  target?: string | null;
  editablePayload?: string | null;
  status: "pending" | "approved" | "rejected";
  scope?: ApprovalScope | null;
  decisionNote?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
}

export interface CommandSafetyPolicy {
  blockedFolders: string[];
  blockedApps: string[];
  keepAwakeWhileRunning: boolean;
}

export interface CommandGoalItem {
  id: string;
  title: string;
  description: string;
  status: "active" | "completed" | "paused";
  preferredProvider?: ProviderId | null;
  progressPercent: number;
  nextAction: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommandScheduledTaskItem {
  id: string;
  name: string;
  scheduleLabel: string;
  status: "active" | "paused" | "external";
  source: "supervisor" | "launchd" | "muse_patrol" | "newpc_timer";
  detail: string;
}

export interface CommandIdeaItem {
  id: string;
  title: string;
  reason: string;
  provider: ProviderId;
  model?: string | null;
  effort: EffortLevel;
  prompt: string;
  badge: string;
}

export type MemoryCategory =
  | "rule"
  | "preference"
  | "project"
  | "fact"
  | "workflow";

export interface StructuredMemoryItem {
  id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  pinned: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type LocalAppId = "notes" | "reminders" | "calendar";
export type LocalSyncMode = "off" | "on_demand" | "auto_brief";

export interface LocalConnectorConfig {
  id: LocalAppId;
  name: string;
  accessMode: "read_only";
  syncMode: LocalSyncMode;
  maxItems: number;
  lastSyncedAt?: string | null;
  lastError?: string | null;
}

export interface LocalConnectorEntry {
  id: string;
  app: LocalAppId;
  title: string;
  subtitle?: string;
  snippet?: string;
  dateLabel?: string;
}

export interface BrainHubResponse {
  ok?: boolean;
  updatedAt: string;
  goals: CommandGoalItem[];
  scheduledTasks: CommandScheduledTaskItem[];
  ideas: CommandIdeaItem[];
  memories?: StructuredMemoryItem[];
  connectors?: LocalConnectorConfig[];
}

export interface CommandOverviewResponse {
  updatedAt: string;
  probedAt?: string;
  stale?: boolean;
  revalidating?: boolean;
  commanderPolicy?: {
    noAutoDowngrade: true;
    summary: string;
  };
  providers: CommandProviderCard[];
  alerts: CommandAlert[];
  chats: CommandChatItem[];
  supervisor?: SupervisorState;
  approvals?: CommandApprovalItem[];
  safetyPolicy?: CommandSafetyPolicy;
}

export interface CommandRecommendWorker {
  provider: ProviderId;
  name: string;
  roleLabel: string;
  model: string | null;
  modelLabel?: string | null;
  effort: EffortLevel;
  reason: string;
  promptSuggestion: string;
}

export interface CommandRecommendResponse {
  ok: true;
  task: string;
  commanderPolicy: {
    noAutoDowngrade: true;
    summary: string;
  };
  commander: {
    provider: "antigravity";
    name: string;
    available: boolean;
    model: string | null;
    modelLabel: string | null;
    effort: EffortLevel;
    reason: string;
  };
  workers: CommandRecommendWorker[];
  warnings: string[];
}

// ── Phase E: Right-Pane Multi-Format Workbench ──

export type WorkbenchFileKind =
  | "markdown"
  | "csv"
  | "mermaid"
  | "pdf"
  | "image"
  | "code";

export interface WorkbenchReadResponse {
  ok: true;
  path: string;
  name: string;
  ext: string;
  kind: WorkbenchFileKind;
  size: number;
  mtime: string;
  content: string | null;
  rawUrl: string | null;
  editable: boolean;
  startLine?: number | null;
  endLine?: number | null;
}

export interface WorkbenchRecentFileItem {
  path: string;
  name: string;
  kind: WorkbenchFileKind;
  mtime: string;
  size: number;
  source: "artifact" | "workspace";
}

// ── Agent & Background Task Visualization ──

export interface ConversationAgentItem {
  id: string;
  role: string;
  typeName: string;
  state: string;
  status: string;
  running: boolean;
  stepCount?: number;
  spawnStepIndex?: number;
  lastModifiedTime: string;
}

export interface BackgroundTaskLogItem {
  id: string;
  fileName: string;
  sizeBytes: number;
  updatedAt: string;
  isActive: boolean;
  tailPreview: string;
}

export interface ConversationAgentsResponse {
  conversationId: string;
  subagents: ConversationAgentItem[];
  tasks: BackgroundTaskLogItem[];
  counts: {
    subagents: number;
    runningSubagents: number;
    tasks: number;
    activeTasks: number;
  };
}

// ── Extensions (MCP / Skills / Plugins / Personal Memory / Global Rules) ──

export interface McpServerEntry {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  headerKeys: string[];
  disabled: boolean;
}

export interface SkillEntry {
  slug: string;
  name: string;
  description: string;
  source: "user" | "plugin" | "builtin";
  pluginName?: string;
  path: string;
  editable: boolean;
  bodyPreview: string;
  body?: string;
}

export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  version?: string;
  path: string;
  skillCount: number;
  hasMcp: boolean;
  disabled: boolean;
}

export interface MemoryItem {
  id: string;
  title: string;
  content: string;
  category: "profile" | "preference" | "project" | "other";
  enabled: boolean;
  updatedAt: string;
}

export interface ExtensionOverviewResponse {
  ok: true;
  mcpServers: McpServerEntry[];
  skills: SkillEntry[];
  plugins: PluginEntry[];
  memories: MemoryItem[];
  globalRules: string;
  paths: {
    mcpConfigPath: string;
    skillsDir: string;
    pluginsDir: string;
    rulesPath: string;
  };
}

export interface ReleaseAssetInfo {
  name: string;
  downloadUrl: string;
  size: number;
  sha256: string | null;
}

export interface UpdateCheckResponse {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseUrl: string;
  publishedAt: string | null;
  zipAsset: ReleaseAssetInfo | null;
  dmgAsset: ReleaseAssetInfo | null;
  checkedAt: string;
  source: "github-api" | "github-redirect" | "error";
  error?: string;
}
