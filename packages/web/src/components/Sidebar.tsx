import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import type { ConversationEntry } from "../hooks/useConversations";
import { getAppIconUrl } from "../hooks/useClientSettings";
import type { AppIconPreset, AppTier, ProjectEntry } from "../types";
import { api } from "../api/client";
import { workspaceNameFromMetadata } from "../utils/workspaceNames";
import {
  IconPlus,
  IconSearch,
  IconMenu,
  IconMore,
  IconX,
  IconSpinner,
  IconGear,
  IconFolder,
  IconFolderPlus,
  IconFilter,
} from "./Icons";

interface Props {
  conversations: ConversationEntry[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onNewInProject?: (project: ProjectEntry) => void;
  onBranchSideChat?: (conv: ConversationEntry) => void;
  onOpenAgentPanel?: (convId: string) => void;
  onDelete: (id: string) => void;
  onRefresh?: () => void;
  onSettings: () => void;
  appTier?: AppTier;
  onMultiAI?: () => void;
  isMultiAI?: boolean;
  appIconPreset?: AppIconPreset;
  loading: boolean;
  connected: boolean;
  isOpen: boolean;
  onToggle: () => void;
}

interface WorkspaceGroup {
  name: string;
  isRunningSection?: boolean;
  isPinnedSection?: boolean;
  project?: ProjectEntry;
  conversations: ConversationEntry[];
  hasRunning: boolean;
}

const PREVIEW_COUNT = 10;

function parseSafeTime(iso?: string): number {
  if (!iso) return 0;
  const ts = new Date(iso).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function relativeTime(iso?: string): string {
  const ts = parseSafeTime(iso);
  if (!ts) return "たった今";
  const diff = Date.now() - ts;
  if (!Number.isFinite(diff) || diff < 0) return "たった今";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "たった今";
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `${days}日前`;
}

function extractWorkspaceName(conv: ConversationEntry): string {
  if (conv.summary.projectName) {
    return conv.summary.projectName;
  }
  const name = workspaceNameFromMetadata(conv.summary.workspaces?.[0], {
    collapseAntigravityPlayground: true,
  });
  return name === "Others" ? "ワークスペースなし" : name;
}

function isUnloaded(conv: ConversationEntry): boolean {
  return conv.summary.status === "CASCADE_RUN_STATUS_UNLOADED";
}

function isArchived(conv: ConversationEntry): boolean {
  return conv.summary.annotations?.archived === true;
}

function isConvRunning(conv: ConversationEntry): boolean {
  return (
    conv.summary.status === "CASCADE_RUN_STATUS_RUNNING" ||
    conv.summary.hasRunningSubagent === true
  );
}

export type CompactModelProvider = "google" | "anthropic" | "openai" | "ollama";

export interface CompactModelBadge {
  text: string;
  provider: CompactModelProvider;
  fullLabel: string;
}

function inferBadgeProvider(
  label: string,
  hint?: CompactModelProvider,
): CompactModelProvider {
  if (hint) return hint;
  if (/claude|anthropic|opus|sonnet|haiku/i.test(label)) return "anthropic";
  if (/\bgpt\b|gpt-|openai|codex|\bo[134](?:-|\b)/i.test(label)) {
    return "openai";
  }
  if (/qwen|ollama|llama|deepseek|mistral|gemma|phi|local-llm/i.test(label)) {
    return "ollama";
  }
  return "google";
}

function abbreviateTier(tier: string): string {
  const t = tier.trim();
  if (/^medium$/i.test(t)) return "Med";
  if (/^minimal$/i.test(t)) return "Min";
  if (/^xhigh$/i.test(t)) return "XHigh";
  if (/^high$/i.test(t)) return "High";
  if (/^low$/i.test(t)) return "Low";
  return t;
}

/**
 * Format a full model label (e.g. "Gemini 4 Neon (High)") into a compact
 * pill label suited for narrow mobile & desktop sidebars ("Neon · High").
 */
export function formatCompactModelBadge(
  modelLabel: string | undefined,
  providerHint?: CompactModelProvider,
): CompactModelBadge | null {
  if (!modelLabel) return null;
  const fullLabel = modelLabel.trim();
  if (!fullLabel || /^MODEL_PLACEHOLDER_/i.test(fullLabel)) return null;

  const provider = inferBadgeProvider(fullLabel, providerHint);

  // Orchestrator (Neon) -> Orch · Neon
  const orchMatch = /^Orchestrator\s*\(([^)]+)\)$/i.exec(fullLabel);
  if (orchMatch) {
    return {
      text: `Orch · ${orchMatch[1].trim()}`,
      provider,
      fullLabel,
    };
  }

  // Gemini 4 Neon (High) -> Neon · High
  const gemini4Match =
    /^Gemini\s+4(?:\.\d+)?\s+([A-Za-z0-9.+-]+)(?:\s*\(([^)]+)\))?$/i.exec(
      fullLabel,
    );
  if (gemini4Match) {
    const family = gemini4Match[1].trim();
    const tier = gemini4Match[2] ? abbreviateTier(gemini4Match[2]) : "";
    return {
      text: tier ? `${family} · ${tier}` : family,
      provider,
      fullLabel,
    };
  }

  // Gemini 3.8 Flash (High) -> Flash 3.8 · High
  const geminiFlashMatch =
    /^Gemini\s+([\d.]+)\s+(Flash|Pro|Ultra)(?:\s*\(([^)]+)\))?$/i.exec(
      fullLabel,
    );
  if (geminiFlashMatch) {
    const ver = geminiFlashMatch[1];
    const kind = geminiFlashMatch[2];
    const tier = geminiFlashMatch[3] ? abbreviateTier(geminiFlashMatch[3]) : "";
    const base = /^flash$/i.test(kind) ? `Flash ${ver}` : `Gemini ${ver}`;
    return {
      text: tier ? `${base} · ${tier}` : base,
      provider,
      fullLabel,
    };
  }

  // Claude Opus 5.5 (High) -> Opus 5.5 · High
  const claudeMatch =
    /^Claude\s+(Opus|Sonnet|Haiku)(?:\s+([\d.]+))?(?:\s*\(([^)]+)\))?$/i.exec(
      fullLabel,
    );
  if (claudeMatch) {
    const name = claudeMatch[1];
    const ver = claudeMatch[2] ? ` ${claudeMatch[2]}` : "";
    const rawTier = claudeMatch[3]?.trim() ?? "";
    const tier =
      rawTier && !/^thinking$/i.test(rawTier) ? abbreviateTier(rawTier) : "";
    return {
      text: tier ? `${name}${ver} · ${tier}` : `${name}${ver}`,
      provider,
      fullLabel,
    };
  }

  // GPT-OSS 120B (Medium) -> GPT-OSS 120B
  const gptOssMatch = /^GPT-OSS\s+(\d+B)(?:\s*\(([^)]+)\))?$/i.exec(fullLabel);
  if (gptOssMatch) {
    return {
      text: `GPT-OSS ${gptOssMatch[1].toUpperCase()}`,
      provider,
      fullLabel,
    };
  }

  // OpenAI GPT-5.x (High)
  const gptMatch = /^(GPT-[\d.]+(?:\s*\w+)?)(?:\s*\(([^)]+)\))?$/i.exec(
    fullLabel,
  );
  if (gptMatch) {
    const base = gptMatch[1].trim();
    const tier = gptMatch[2] ? abbreviateTier(gptMatch[2]) : "";
    return {
      text: tier ? `${base} · ${tier}` : base,
      provider,
      fullLabel,
    };
  }

  // Local Ollama / Qwen models
  if (provider === "ollama") {
    const sizeMatch = /(\d+(?:\.\d+)?b)\b/i.exec(fullLabel);
    const sizeStr = sizeMatch ? ` ${sizeMatch[1].toUpperCase()}` : "";
    if (/local-llm/i.test(fullLabel)) {
      return { text: `ローカル${sizeStr}`, provider, fullLabel };
    }
    if (/qwen/i.test(fullLabel)) {
      return { text: `Qwen${sizeStr}`, provider, fullLabel };
    }
    const cleanLocal = fullLabel.split(":")[0].trim();
    return { text: `${cleanLocal}${sizeStr}`.trim(), provider, fullLabel };
  }

  // Generic fallback: shorten parenthetical tier
  const genericMatch = /^([^(]+?)\s*\(([^)]+)\)$/.exec(fullLabel);
  if (genericMatch) {
    return {
      text: `${genericMatch[1].trim()} · ${abbreviateTier(genericMatch[2])}`,
      provider,
      fullLabel,
    };
  }

  return { text: fullLabel, provider, fullLabel };
}

/** Desktop-equivalent context menu (Rename / Pin / Branch / Archive / Delete) */
function ContextMenu({
  title,
  isPinned,
  onRename,
  onTogglePin,
  onBranchSideChat,
  onArchive,
  onDelete,
  onClose,
}: {
  title: string;
  isPinned: boolean;
  onRename: () => void;
  onTogglePin: () => void;
  onBranchSideChat?: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      onClick={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <div className="context-menu-header" title={title}>
        {title}
      </div>
      <button
        type="button"
        className="context-menu-item"
        onClick={(e) => {
          e.stopPropagation();
          onRename();
          onClose();
        }}
      >
        <span>✏️ 名前を変更</span>
      </button>
      <button
        type="button"
        className="context-menu-item"
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin();
          onClose();
        }}
      >
        <span>{isPinned ? "📌 ピン留めを解除" : "📌 ピン留め"}</span>
      </button>
      {onBranchSideChat && (
        <button
          type="button"
          className="context-menu-item"
          onClick={(e) => {
            e.stopPropagation();
            onBranchSideChat();
            onClose();
          }}
        >
          <span>🌿 枝分かれ</span>
        </button>
      )}
      <button
        type="button"
        className="context-menu-item"
        onClick={(e) => {
          e.stopPropagation();
          onArchive();
          onClose();
        }}
      >
        <span>📦 アーカイブへ移動</span>
      </button>
      <div className="context-menu-divider" />
      <button
        type="button"
        className="context-menu-item danger"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
          onClose();
        }}
      >
        <span>🗑️ 削除</span>
      </button>
    </div>
  );
}

// ── Sidebar action items ──

interface SidebarAction {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}

export function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onNewInProject,
  onBranchSideChat,
  onOpenAgentPanel,
  onDelete,
  onRefresh,
  onSettings,
  appTier = "lite",
  onMultiAI,
  isMultiAI = false,
  appIconPreset,
  loading,
  connected,
  isOpen,
  onToggle,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandedSubagents, setExpandedSubagents] = useState<
    Record<string, boolean>
  >({});
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [localTitleOverrides, setLocalTitleOverrides] = useState<
    Record<string, string>
  >({});
  const [localPinnedOverrides, setLocalPinnedOverrides] = useState<
    Record<string, boolean>
  >({});
  const [localArchivedIds, setLocalArchivedIds] = useState<
    Record<string, boolean>
  >({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [providerFilter, setProviderFilter] = useState<
    "all" | CompactModelProvider
  >("all");
  const [subagentOnlyFilter, setSubagentOnlyFilter] = useState(false);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [hideEmptyProjects, setHideEmptyProjects] = useState(false);
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectFolder, setNewProjectFolder] = useState("");
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      if (typeof api.projects !== "function") return;
      const res = await api.projects();
      if (Array.isArray(res?.projects)) {
        setProjects(res.projects);
      }
    } catch {
      // Non-fatal if /api/projects is unavailable
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects, connected]);

  useEffect(() => {
    if (!projectMenuId) return;
    const onOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest?.(".sidebar-project-menu-wrap")) {
        setProjectMenuId(null);
      }
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [projectMenuId]);

  const handleCreateProject = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (projectSaving) return;
      const name = newProjectName.trim();
      const folderPath = newProjectFolder.trim();
      if (!name && !folderPath) {
        setProjectError("名前またはフォルダパスを入力してください");
        return;
      }
      setProjectSaving(true);
      setProjectError(null);
      try {
        const res = await api.createProject({ name, folderPath });
        if (res?.project) {
          setProjects((prev) => [...prev, res.project]);
          setNewProjectName("");
          setNewProjectFolder("");
          setAddProjectOpen(false);
        }
      } catch (err) {
        setProjectError(
          err instanceof Error ? err.message : "プロジェクトの追加に失敗しました",
        );
      } finally {
        setProjectSaving(false);
      }
    },
    [newProjectFolder, newProjectName, projectSaving],
  );

  const handleDeleteProject = useCallback(
    async (proj: ProjectEntry) => {
      try {
        await api.deleteProject(proj.id);
        setProjects((prev) => prev.filter((p) => p.id !== proj.id));
      } catch (err) {
        console.error("Failed to delete project:", err);
      } finally {
        setProjectMenuId(null);
      }
    },
    [],
  );

  const matchConversationProject = useCallback(
    (conv: ConversationEntry): ProjectEntry | undefined => {
      if (projects.length === 0) return undefined;
      const metaProjId = (conv.summary.trajectoryMetadata as { projectId?: string } | undefined)?.projectId;
      if (metaProjId) {
        const byId = projects.find((p) => p.id === metaProjId);
        if (byId) return byId;
      }
      const wsUri = conv.summary.workspaces?.[0]?.workspaceFolderAbsoluteUri?.replace(
        /\/+$/,
        "",
      );
      if (wsUri) {
        const byUri = projects.find(
          (p) => p.folderUri && p.folderUri.replace(/\/+$/, "") === wsUri,
        );
        if (byUri) return byUri;
      }
      const wsName = extractWorkspaceName(conv);
      return projects.find((p) => p.name === wsName);
    },
    [projects],
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    | {
        id: string;
        title: string;
        snippets: string[];
        matchCount: number;
        modelLabel?: string;
        modelProvider?: CompactModelProvider;
      }[]
    | null
  >(null);

  const conversationById = useMemo(() => {
    const map = new Map<string, ConversationEntry>();
    for (const c of conversations) {
      map.set(c.id, c);
    }
    return map;
  }, [conversations]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const touchStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const closeMenu = useCallback(() => setMenuOpen(null), []);

  const handleStartRename = useCallback(
    (conv: ConversationEntry) => {
      const currentTitle =
        localTitleOverrides[conv.id] ?? conv.summary.summary ?? "";
      setRenamingId(conv.id);
      setRenameValue(currentTitle);
      setTimeout(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      }, 30);
    },
    [localTitleOverrides],
  );

  const handleCommitRename = useCallback(
    async (convId: string) => {
      const trimmed = renameValue.trim();
      setRenamingId(null);
      if (!trimmed) return;
      setLocalTitleOverrides((prev) => ({ ...prev, [convId]: trimmed }));
      try {
        await api.updateAnnotations(convId, { title: trimmed });
        onRefresh?.();
      } catch (err) {
        console.error("Failed to rename conversation:", err);
      }
    },
    [renameValue, onRefresh],
  );

  useEffect(() => {
    setLocalPinnedOverrides((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      let changed = false;
      const next = { ...prev };
      for (const id of keys) {
        const conv = conversations.find((c) => c.id === id);
        if (!conv) continue;
        const serverPinned = conv.summary.annotations?.pinned === true;
        if (serverPinned === prev[id]) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [conversations]);

  const handleTogglePin = useCallback(
    async (conv: ConversationEntry) => {
      const currentPinned =
        localPinnedOverrides[conv.id] ??
        conv.summary.annotations?.pinned === true;
      const nextPinned = !currentPinned;
      setLocalPinnedOverrides((prev) => ({ ...prev, [conv.id]: nextPinned }));
      if (nextPinned) {
        setCollapsed((prev) =>
          prev["📌 ピン留め"] ? { ...prev, "📌 ピン留め": false } : prev,
        );
      }
      try {
        await api.updateAnnotations(conv.id, { pinned: nextPinned });
        onRefresh?.();
      } catch (err) {
        console.error("Failed to toggle pin:", err);
        setLocalPinnedOverrides((prev) => {
          const next = { ...prev };
          delete next[conv.id];
          return next;
        });
      }
    },
    [localPinnedOverrides, onRefresh],
  );

  const handleArchive = useCallback(
    async (conv: ConversationEntry) => {
      setLocalArchivedIds((prev) => ({ ...prev, [conv.id]: true }));
      if (conv.id === activeId) {
        onNew();
      }
      try {
        await api.updateAnnotations(conv.id, { archived: true });
        onRefresh?.();
      } catch (err) {
        console.error("Failed to archive conversation:", err);
      }
    },
    [activeId, onNew, onRefresh],
  );

  const providerCounts = useMemo(() => {
    const counts: Record<CompactModelProvider, number> = {
      google: 0,
      anthropic: 0,
      openai: 0,
      ollama: 0,
    };
    for (const conv of conversations) {
      if (isArchived(conv) || localArchivedIds[conv.id]) continue;
      const meta = conv.summary.trajectoryMetadata;
      if (
        meta?.parentConversationId ||
        meta?.subagentSpec ||
        (typeof meta?.nestingDepth === "number" && meta.nestingDepth > 0)
      ) {
        continue;
      }
      const badge = formatCompactModelBadge(
        conv.summary.modelLabel,
        conv.summary.modelProvider,
      );
      if (badge) {
        counts[badge.provider] += 1;
      }
    }
    return counts;
  }, [conversations, localArchivedIds]);

  const activeProviders = useMemo(
    () =>
      (["google", "anthropic", "openai", "ollama"] as const).filter(
        (p) => providerCounts[p] > 0,
      ),
    [providerCounts],
  );

  useEffect(() => {
    if (providerFilter !== "all" && providerCounts[providerFilter] === 0) {
      setProviderFilter("all");
    }
  }, [providerFilter, providerCounts]);

  const totalSubagentCount = useMemo(() => {
    let count = 0;
    for (const conv of conversations) {
      if (isArchived(conv) || localArchivedIds[conv.id]) continue;
      count += conv.summary.subagents?.length ?? 0;
      count += conv.summary.activeTasks?.length ?? 0;
    }
    return count;
  }, [conversations, localArchivedIds]);

  useEffect(() => {
    if (subagentOnlyFilter && totalSubagentCount === 0) {
      setSubagentOnlyFilter(false);
    }
  }, [subagentOnlyFilter, totalSubagentCount]);

  const groups = useMemo<WorkspaceGroup[]>(() => {
    const runningList: ConversationEntry[] = [];
    const pinnedList: ConversationEntry[] = [];
    const projectMap = new Map<string, ConversationEntry[]>();
    const workspaceMap = new Map<string, ConversationEntry[]>();

    for (const proj of projects) {
      projectMap.set(proj.id, []);
    }

    for (const conv of conversations) {
      if (isArchived(conv) || localArchivedIds[conv.id]) continue;
      const meta = conv.summary.trajectoryMetadata;
      if (
        meta?.parentConversationId ||
        meta?.subagentSpec ||
        (typeof meta?.nestingDepth === "number" && meta.nestingDepth > 0)
      ) {
        continue;
      }
      if (
        subagentOnlyFilter &&
        !(
          (conv.summary.subagents && conv.summary.subagents.length > 0) ||
          (conv.summary.activeTasks && conv.summary.activeTasks.length > 0)
        )
      ) {
        continue;
      }
      if (providerFilter !== "all") {
        const badge = formatCompactModelBadge(
          conv.summary.modelLabel,
          conv.summary.modelProvider,
        );
        if (!badge || badge.provider !== providerFilter) continue;
      }

      if (isConvRunning(conv)) {
        runningList.push(conv);
        continue;
      }

      const isPinned =
        localPinnedOverrides[conv.id] ??
        conv.summary.annotations?.pinned === true;

      if (isPinned) {
        pinnedList.push(conv);
      } else {
        const matchedProj = matchConversationProject(conv);
        if (matchedProj) {
          const list = projectMap.get(matchedProj.id) ?? [];
          list.push(conv);
          projectMap.set(matchedProj.id, list);
        } else {
          const name = extractWorkspaceName(conv);
          const list = workspaceMap.get(name) ?? [];
          list.push(conv);
          workspaceMap.set(name, list);
        }
      }
    }

    const result: WorkspaceGroup[] = [];

    // 0. Top-most Running section: any active/running chat (or chat with a running subagent)
    // ALWAYS jumps to the very top of the sidebar regardless of pin/workspace group.
    if (runningList.length > 0) {
      runningList.sort((a, b) => {
        const aPinned =
          localPinnedOverrides[a.id] ?? a.summary.annotations?.pinned === true;
        const bPinned =
          localPinnedOverrides[b.id] ?? b.summary.annotations?.pinned === true;
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        const aDirect = a.summary.status === "CASCADE_RUN_STATUS_RUNNING";
        const bDirect = b.summary.status === "CASCADE_RUN_STATUS_RUNNING";
        if (aDirect !== bDirect) return aDirect ? -1 : 1;
        return (
          parseSafeTime(b.summary.lastModifiedTime) -
          parseSafeTime(a.summary.lastModifiedTime)
        );
      });

      result.push({
        name: "⚡ 実行中",
        isRunningSection: true,
        conversations: runningList,
        hasRunning: true,
      });
    }

    // 1. Top-level Pinned section (Desktop Antigravity IDE equivalent)
    if (pinnedList.length > 0) {
      pinnedList.sort(
        (a, b) =>
          parseSafeTime(b.summary.lastModifiedTime) -
          parseSafeTime(a.summary.lastModifiedTime),
      );

      result.push({
        name: "📌 ピン留め",
        isPinnedSection: true,
        conversations: pinnedList,
        hasRunning: false,
      });
    }

    // 2. Registered Projects (Antigravity-style unified project folders containing their chats)
    const projectGroups: WorkspaceGroup[] = [];
    for (const proj of projects) {
      const convs = projectMap.get(proj.id) ?? [];
      if (hideEmptyProjects && convs.length === 0) continue;
      convs.sort((a, b) => {
        const aRunning = isConvRunning(a);
        const bRunning = isConvRunning(b);
        if (aRunning !== bRunning) return aRunning ? -1 : 1;
        return (
          parseSafeTime(b.summary.lastModifiedTime) -
          parseSafeTime(a.summary.lastModifiedTime)
        );
      });
      projectGroups.push({
        name: proj.name,
        project: proj,
        conversations: convs,
        hasRunning: convs.some((c) => isConvRunning(c)),
      });
    }

    // 3. Other / Unregistered workspace groups (e.g., ワークスペースなし)
    const workspaceGroups: WorkspaceGroup[] = Array.from(workspaceMap.entries())
      .map(([name, convs]) => {
        convs.sort((a, b) => {
          const aRunning = isConvRunning(a);
          const bRunning = isConvRunning(b);
          if (aRunning !== bRunning) return aRunning ? -1 : 1;
          return (
            parseSafeTime(b.summary.lastModifiedTime) -
            parseSafeTime(a.summary.lastModifiedTime)
          );
        });
        return {
          name,
          conversations: convs,
          hasRunning: convs.some((c) => isConvRunning(c)),
        };
      })
      .sort((a, b) => {
        if (a.hasRunning !== b.hasRunning) return a.hasRunning ? -1 : 1;
        if (a.name === "ワークスペースなし" && b.name !== "ワークスペースなし") return 1;
        if (a.name !== "ワークスペースなし" && b.name === "ワークスペースなし") return -1;

        const aHasActive = a.conversations.some((c) => !isUnloaded(c));
        const bHasActive = b.conversations.some((c) => !isUnloaded(c));
        if (aHasActive !== bHasActive) return aHasActive ? -1 : 1;
        const aTime = Math.max(
          0,
          ...a.conversations.map((c) => parseSafeTime(c.summary.lastModifiedTime)),
        );
        const bTime = Math.max(
          0,
          ...b.conversations.map((c) => parseSafeTime(c.summary.lastModifiedTime)),
        );

        return bTime - aTime;
      });

    return [...result, ...projectGroups, ...workspaceGroups];
  }, [
    conversations,
    localArchivedIds,
    localPinnedOverrides,
    providerFilter,
    subagentOnlyFilter,
    projects,
    hideEmptyProjects,
    matchConversationProject,
  ]);

  const toggleGroup = (name: string) => {
    setCollapsed((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  const toggleExpanded = (name: string) => {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  const actions: SidebarAction[] = [
    { icon: <IconPlus size={14} />, label: "新規チャット", onClick: onNew },
    ...(appTier === "pro" && onMultiAI
      ? [
          {
            icon: (
              <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>
                ⚡
              </span>
            ),
            label: "マルチAI",
            onClick: onMultiAI,
            active: isMultiAI,
          },
        ]
      : []),
    {
      icon: <IconSearch size={14} />,
      label: "検索",
      onClick: () => {
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      },
    },
    { icon: <IconGear size={14} />, label: "設定", onClick: onSettings },
  ];

  // Debounced search
  const handleSearchInput = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);

    if (!value.trim()) {
      setSearchResults(null);
      setSearching(false);
      return;
    }

    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const data = await api.search(value.trim());
        setSearchResults(data.results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults(null);
    setSearching(false);
  }, []);

  // Track when each conversation was last "seen" by the user.
  // Stored as { convId: lastModifiedTime-at-moment-of-opening }.
  const [seenAt, setSeenAt] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("porta:seenAt") ?? "{}");
    } catch {
      return {};
    }
  });

  const markSeen = useCallback(
    (convId: string) => {
      const conv = conversations.find((c) => c.id === convId);
      if (!conv) return;
      setSeenAt((prev) => {
        if (prev[convId] === conv.summary.lastModifiedTime) return prev;
        const next = { ...prev, [convId]: conv.summary.lastModifiedTime };
        try {
          localStorage.setItem("porta:seenAt", JSON.stringify(next));
        } catch {
          // localStorage can be unavailable in restricted browser contexts.
        }
        return next;
      });
    },
    [conversations],
  );

  // Auto-mark active thread as seen when it receives updates
  useEffect(() => {
    if (activeId) markSeen(activeId);
  }, [activeId, conversations, markSeen]);

  const renderItem = (conv: ConversationEntry) => {
    const isActive = conv.id === activeId;
    const isRunning = isConvRunning(conv);
    const hasRunningSubagent = conv.summary.hasRunningSubagent === true;
    const subagents = conv.summary.subagents ?? [];
    const activeTasks = conv.summary.activeTasks ?? [];
    const taskCount = conv.summary.taskCount ?? 0;
    const hasActiveTask = activeTasks.length > 0;
    const hasAgentActivity = hasRunningSubagent || hasActiveTask;
    const agentTreeCount = subagents.length + activeTasks.length;
    const hasActiveChild = subagents.some((s) => s.id === activeId);
    // Default to expanded for active/running chats or small agent sets (<= 3);
    // collapse large idle agent trees by default so pinned/other chats stay visible.
    const isSubagentsOpen =
      expandedSubagents[conv.id] ??
      (hasAgentActivity ||
        hasActiveChild ||
        (agentTreeCount > 0 && (isActive || agentTreeCount <= 3)));
    const lastSeen = seenAt[conv.id];
    const displayTitle =
      (localTitleOverrides[conv.id] ?? conv.summary.summary)?.trim() ||
      "新しいチャット";
    const isPinned =
      localPinnedOverrides[conv.id] ??
      conv.summary.annotations?.pinned === true;
    const isRenaming = renamingId === conv.id;

    // Show update dot only if the thread was *previously opened* and
    // has been modified since we last saw it.
    // No seenAt record = never opened → no "update" concept → no dot.
    const hasUpdates =
      !isRunning &&
      !isActive &&
      !!lastSeen &&
      new Date(conv.summary.lastModifiedTime).getTime() >
        new Date(lastSeen).getTime();

    return (
      <div key={conv.id} className="sidebar-item-group">
      <div
        className={`sidebar-item ${isActive ? "active" : ""} ${isRunning ? "running" : ""} ${isRunning && isActive ? "active-running" : ""} ${isUnloaded(conv) ? "dimmed" : ""} ${menuOpen === conv.id ? "menu-open" : ""}`}
        onTouchStart={(e) => {
          if (isRenaming) return;
          const touch = e.touches[0];
          if (!touch) return;
          touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
          longPressTriggeredRef.current = false;
          if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = setTimeout(() => {
            longPressTriggeredRef.current = true;
            if (typeof navigator !== "undefined" && navigator.vibrate) {
              navigator.vibrate(20);
            }
            setMenuOpen(conv.id);
          }, 450);
        }}
        onTouchMove={(e) => {
          if (!longPressTimerRef.current) return;
          const touch = e.touches[0];
          if (!touch) return;
          const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
          const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
          if (dx > 10 || dy > 10) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
          }
        }}
        onTouchEnd={() => {
          if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
          }
        }}
        onTouchCancel={() => {
          if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
          }
        }}
        onContextMenu={(e) => {
          if (isRenaming) return;
          e.preventDefault();
          e.stopPropagation();
          setMenuOpen(conv.id);
        }}
        onClick={(e) => {
          if (isRenaming) return;
          if (longPressTriggeredRef.current) {
            e.preventDefault();
            e.stopPropagation();
            longPressTriggeredRef.current = false;
            return;
          }
          markSeen(conv.id);
          onSelect(conv.id);
        }}
      >
        <div className="sidebar-item-content">
          {isRenaming ? (
            <div
              className="sidebar-rename-box"
              onClick={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            >
              <input
                ref={renameInputRef}
                type="text"
                className="sidebar-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleCommitRename(conv.id);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setRenamingId(null);
                  }
                }}
              />
              <div className="sidebar-rename-actions">
                <button
                  type="button"
                  className="sidebar-rename-btn save"
                  onClick={() => void handleCommitRename(conv.id)}
                >
                  保存
                </button>
                <button
                  type="button"
                  className="sidebar-rename-btn cancel"
                  onClick={() => setRenamingId(null)}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className={`sidebar-item-title ${isRunning ? "running" : ""}`}>
                {isRunning && (
                  <span
                    className="sidebar-running-spinner-wrap"
                    title={isActive ? "現在開いているチャット (実行中)" : "バックグラウンド実行中"}
                  >
                    <IconSpinner
                      size={13}
                      className={`sidebar-running-spinner ${isActive ? "active-chat" : ""}`}
                    />
                  </span>
                )}
                {isPinned && (
                  <button
                    type="button"
                    className="sidebar-pin-badge"
                    title="クリックでピン留めを解除"
                    aria-label="ピン留めを解除"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleTogglePin(conv);
                    }}
                  >
                    📌
                  </button>
                )}
                <span
                  className={
                    isRunning
                      ? `sidebar-title-blinking ${isActive ? "active-chat" : ""}`
                      : ""
                  }
                >
                  {displayTitle}
                </span>
              </div>
              <div className="sidebar-item-meta">
                {(() => {
                  const modelBadge = formatCompactModelBadge(
                    conv.summary.modelLabel,
                    conv.summary.modelProvider,
                  );
                  return (
                    <>
                      {modelBadge && (
                        <span
                          className={`sidebar-model-badge provider-${modelBadge.provider}`}
                          title={`使用モデル: ${modelBadge.fullLabel}`}
                          data-testid="sidebar-model-badge"
                        >
                          <span
                            className="sidebar-model-dot"
                            aria-hidden="true"
                          />
                          <span className="sidebar-model-badge-text">
                            {modelBadge.text}
                          </span>
                        </span>
                      )}
                      {isRunning ? (
                        <span
                          className={`sidebar-running-status-label ${isActive ? "active-chat" : ""}`}
                        >
                          <span
                            className={`sidebar-running-dot ${isActive ? "active-chat" : ""}`}
                          />{" "}
                          {conv.summary.status !== "CASCADE_RUN_STATUS_RUNNING" &&
                          hasAgentActivity
                            ? "● エージェント稼働中..."
                            : isActive
                              ? "● 現在操作中 (実行中)..."
                              : "● バックグラウンド実行中..."}
                        </span>
                      ) : (
                        <span className="sidebar-meta-details">
                          {relativeTime(conv.summary.lastModifiedTime)}
                          {" · "}
                          {conv.summary.stepCount ?? 0} ステップ
                          {conv.summary.projectName && (
                            <span className="sidebar-meta-project">
                              {" · "}
                              {conv.summary.projectName}
                            </span>
                          )}
                        </span>
                      )}
                    </>
                  );
                })()}
              </div>
              {(agentTreeCount > 0 || taskCount > 0) && (
                <div className="sidebar-subagents-bar">
                  {agentTreeCount > 0 ? (
                    <button
                      type="button"
                      className={`sidebar-subagents-toggle ${hasAgentActivity ? "running" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedSubagents((prev) => ({
                          ...prev,
                          [conv.id]: !isSubagentsOpen,
                        }));
                      }}
                      title="このチャット配下のエージェントを表示／折りたたむ"
                    >
                      <span>
                        🤖{" "}
                        {hasAgentActivity
                          ? `エージェント稼働中 (${agentTreeCount}件)`
                          : `エージェント (${agentTreeCount}件)`}
                      </span>
                      <span className="sidebar-subagents-toggle-caret">
                        {isSubagentsOpen ? "▴" : "▾"}
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="sidebar-subagents-toggle sidebar-tasks-pill"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenAgentPanel?.(conv.id);
                      }}
                      title="バックグラウンドタスクログを開く"
                    >
                      <span>⚙️ タスクログ ({taskCount}件)</span>
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        {!isRenaming && (
          <div className="sidebar-item-right">
            {isRunning && (
              <IconSpinner
                size={13}
                className={`item-indicator ${isActive ? "active-chat" : ""}`}
                style={
                  isActive
                    ? {
                        color: "#34d399",
                        filter:
                          "drop-shadow(0 0 6px rgba(52, 211, 153, 0.9))",
                      }
                    : undefined
                }
              />
            )}
            {hasUpdates && <span className="item-dot" />}
            <button
              type="button"
              className="sidebar-item-menu-btn"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(menuOpen === conv.id ? null : conv.id);
              }}
              title="メニュー"
            >
              <IconMore size={14} />
            </button>
            {menuOpen === conv.id && (
              <ContextMenu
                title={displayTitle}
                isPinned={isPinned}
                onRename={() => handleStartRename(conv)}
                onTogglePin={() => void handleTogglePin(conv)}
                onBranchSideChat={
                  onBranchSideChat ? () => onBranchSideChat(conv) : undefined
                }
                onArchive={() => void handleArchive(conv)}
                onDelete={() => onDelete(conv.id)}
                onClose={closeMenu}
              />
            )}
          </div>
        )}
      </div>
      {agentTreeCount > 0 && isSubagentsOpen && (
        <div className="sidebar-subagents-list">
          {subagents.map((child) => {
            const childActive = child.id === activeId;
            const childRunning =
              child.status === "CASCADE_RUN_STATUS_RUNNING";
            const childBadge = formatCompactModelBadge(
              child.modelLabel,
              child.modelProvider,
            );
            return (
              <button
                key={child.id}
                type="button"
                className={`sidebar-subagent-item ${childActive ? "active" : ""} ${childRunning ? "running" : ""}`}
                onClick={() => onSelect(child.id)}
                title={
                  childBadge
                    ? `${child.role} (${child.typeName}) · ${childBadge.fullLabel}`
                    : `${child.role} (${child.typeName})`
                }
              >
                <span className="sidebar-subagent-icon">
                  {childRunning ? (
                    <IconSpinner
                      size={11}
                      className="sidebar-running-spinner"
                    />
                  ) : (
                    "↳"
                  )}
                </span>
                <span className="sidebar-subagent-title">{child.role}</span>
                {child.typeName && child.typeName !== "subagent" && (
                  <span className="sidebar-subagent-type">{child.typeName}</span>
                )}
                {childBadge && (
                  <span
                    className={`sidebar-model-badge compact provider-${childBadge.provider}`}
                    title={`使用モデル: ${childBadge.fullLabel}`}
                    data-testid="sidebar-subagent-model-badge"
                  >
                    <span className="sidebar-model-dot" aria-hidden="true" />
                    <span className="sidebar-model-badge-text">
                      {childBadge.text}
                    </span>
                  </span>
                )}
                <span className="sidebar-subagent-meta">
                  {childRunning
                    ? "実行中"
                    : relativeTime(child.lastModifiedTime)}
                </span>
              </button>
            );
          })}
          {activeTasks.map((task) => (
            <button
              key={`task-${task.id}`}
              type="button"
              className="sidebar-subagent-item running sidebar-task-item"
              onClick={() => onOpenAgentPanel?.(conv.id)}
              title={`バックグラウンドタスク ${task.id} のログを開く`}
            >
              <span className="sidebar-subagent-icon">
                <IconSpinner size={11} className="sidebar-running-spinner" />
              </span>
              <span className="sidebar-subagent-title">⚙️ {task.id}</span>
              <span className="sidebar-subagent-type">task</span>
              <span className="sidebar-subagent-meta">実行中</span>
            </button>
          ))}
          {taskCount > 0 && onOpenAgentPanel && (
            <button
              type="button"
              className="sidebar-subagent-item sidebar-agent-detail-link"
              onClick={() => onOpenAgentPanel(conv.id)}
              title="このチャットのエージェント・バックグラウンドタスク詳細を開く"
            >
              <span className="sidebar-subagent-icon">📋</span>
              <span className="sidebar-subagent-title">
                タスクログ詳細 ({taskCount}件)
              </span>
              <span className="sidebar-subagent-meta">開く →</span>
            </button>
          )}
        </div>
      )}
      </div>
    );
  };

  // ── Collapsed state: icon strip ──
  if (!isOpen) {
    return (
      <aside className="sidebar sidebar-collapsed">
        <div className="sidebar-collapsed-icons">
          <button
            className="sidebar-icon-btn"
            onClick={onToggle}
            title="サイドバーを開く"
          >
            <IconMenu size={16} />
          </button>
          {actions.map((action, i) => (
            <button
              key={i}
              className={`sidebar-icon-btn ${action.active ? "active" : ""}`}
              onClick={action.onClick}
              title={action.label}
            >
              {action.icon}
            </button>
          ))}
        </div>
        <div
          className="sidebar-collapsed-bottom"
          title={connected ? "接続中" : "未接続"}
        />
      </aside>
    );
  }

  // ── Open state ──
  return (
    <aside className="sidebar">
      {/* Header: brand + collapse */}
      <div className="sidebar-header">
        <span
          className="sidebar-brand-wrap"
          title={connected ? "Antigravity JP（接続中）" : "Antigravity JP（未接続）"}
        >
          <img
            src={getAppIconUrl(appIconPreset)}
            alt="Antigravity JP"
            className="sidebar-brand-icon"
            width={24}
            height={24}
          />
          <span className="sidebar-brand">Antigravity JP</span>
        </span>
        <button
          className="sidebar-icon-btn"
          onClick={onToggle}
          title="サイドバーを閉じる"
        >
          <IconMenu size={16} />
        </button>
      </div>

      {/* Unified scroll body so actions/filters/projects scroll together on phone & desktop */}
      <div className="sidebar-scroll-body">
      {/* Action buttons */}
      <div className="sidebar-actions">
        {actions.map((action, i) => (
          <button
            key={i}
            className={`sidebar-action-btn ${action.active ? "active" : ""}`}
            onClick={action.onClick}
          >
            <span className="sidebar-action-icon">{action.icon}</span>
            <span className="sidebar-action-label">{action.label}</span>
          </button>
        ))}
      </div>

      {/* Smart provider filter strip: only shown when 2+ model providers exist */}
      {activeProviders.length >= 2 && (
        <div
          className="sidebar-provider-filter"
          role="tablist"
          aria-label="モデル系統で絞り込み"
          data-testid="sidebar-provider-filter"
        >
          <button
            type="button"
            role="tab"
            aria-selected={providerFilter === "all"}
            className={`sidebar-provider-pill ${providerFilter === "all" ? "active" : ""}`}
            onClick={() => setProviderFilter("all")}
          >
            すべて
          </button>
          {activeProviders.map((prov) => {
            const label =
              prov === "google"
                ? "Gemini"
                : prov === "anthropic"
                  ? "Claude"
                  : prov === "openai"
                    ? "OpenAI"
                    : "ローカル";
            return (
              <button
                key={prov}
                type="button"
                role="tab"
                aria-selected={providerFilter === prov}
                className={`sidebar-provider-pill provider-${prov} ${providerFilter === prov ? "active" : ""}`}
                onClick={() => setProviderFilter(prov)}
              >
                <span className="sidebar-model-dot" aria-hidden="true" />
                <span>{label}</span>
                <span className="sidebar-provider-pill-count">
                  {providerCounts[prov]}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Child subagent quick filter strip: shown whenever any conversation has child chats */}
      {totalSubagentCount > 0 && (
        <div
          className="sidebar-subagent-filter"
          data-testid="sidebar-subagent-filter"
        >
          <button
            type="button"
            className={`sidebar-provider-pill sidebar-subagent-pill ${subagentOnlyFilter ? "active" : ""}`}
            aria-pressed={subagentOnlyFilter}
            onClick={() => setSubagentOnlyFilter((v) => !v)}
            title="エージェント・実行中タスクを含む会話だけ絞り込む"
          >
            <span>🤖 エージェント</span>
            <span className="sidebar-provider-pill-count">
              {totalSubagentCount}
            </span>
          </button>
        </div>
      )}

      {/* Conversation list */}
      <div className="sidebar-list">
        {loading && conversations.length === 0 ? (
          <div
            style={{ display: "flex", justifyContent: "center", padding: 20 }}
          >
            <div className="loading-spinner" />
          </div>
        ) : (
          <>
            {groups
              .filter((g) => g.isRunningSection || g.isPinnedSection)
              .map((group) => {
                const totalCount = group.conversations.length;
                const isGroupCollapsed = collapsed[group.name] ?? false;
                return (
                  <div
                    key={group.name}
                    className={`workspace-group ${group.isRunningSection ? "running-workspace-group" : ""} ${group.isPinnedSection ? "pinned-workspace-group" : ""}`}
                  >
                    <button
                      type="button"
                      className={`workspace-group-header ${group.isRunningSection ? "running-group-header" : ""} ${group.isPinnedSection ? "pinned-group-header" : ""}`}
                      onClick={() => toggleGroup(group.name)}
                    >
                      <span
                        className={`workspace-group-chevron ${isGroupCollapsed ? "collapsed" : ""}`}
                      >
                        ▾
                      </span>
                      <span className="workspace-group-name">{group.name}</span>
                      {group.hasRunning && (
                        <IconSpinner size={12} className="sidebar-running-spinner" />
                      )}
                      <span className="workspace-group-count">{totalCount}</span>
                    </button>

                    {!isGroupCollapsed && (
                      <div className="workspace-group-items">
                        {group.conversations.map(renderItem)}
                      </div>
                    )}
                  </div>
                );
              })}

            {(projects.length > 0 || addProjectOpen) && (
              <div className="sidebar-projects-bar" data-testid="sidebar-projects">
                <div className="sidebar-projects-header">
                  <span className="sidebar-projects-title">プロジェクト</span>
                  <div className="sidebar-projects-header-actions">
                    <button
                      type="button"
                      className={`sidebar-projects-icon-btn ${hideEmptyProjects ? "active" : ""}`}
                      title={
                        hideEmptyProjects
                          ? "空のプロジェクトも表示"
                          : "会話のあるプロジェクトのみ表示"
                      }
                      aria-label="プロジェクト絞り込み"
                      onClick={() => setHideEmptyProjects((v) => !v)}
                    >
                      <IconFilter size={13} />
                    </button>
                    <button
                      type="button"
                      className={`sidebar-projects-icon-btn ${addProjectOpen ? "active" : ""}`}
                      title="プロジェクトを追加"
                      aria-label="プロジェクトを追加"
                      onClick={() => {
                        setAddProjectOpen((v) => !v);
                        setProjectError(null);
                      }}
                    >
                      <IconFolderPlus size={14} />
                    </button>
                  </div>
                </div>

                {addProjectOpen && (
                  <form
                    className="sidebar-project-add-form"
                    onSubmit={(e) => void handleCreateProject(e)}
                  >
                    <input
                      type="text"
                      className="sidebar-project-input"
                      placeholder="フォルダパス（例: ~/Projects）"
                      value={newProjectFolder}
                      onChange={(e) => setNewProjectFolder(e.target.value)}
                      disabled={projectSaving}
                    />
                    <input
                      type="text"
                      className="sidebar-project-input"
                      placeholder="プロジェクト名（省略時はフォルダ名）"
                      value={newProjectName}
                      onChange={(e) => setNewProjectName(e.target.value)}
                      disabled={projectSaving}
                    />
                    {projectError && (
                      <div className="sidebar-project-error">{projectError}</div>
                    )}
                    <div className="sidebar-project-form-btns">
                      <button
                        type="submit"
                        className="sidebar-project-submit-btn"
                        disabled={projectSaving}
                      >
                        {projectSaving ? "追加中…" : "追加"}
                      </button>
                      <button
                        type="button"
                        className="sidebar-project-cancel-btn"
                        onClick={() => {
                          setAddProjectOpen(false);
                          setProjectError(null);
                        }}
                      >
                        キャンセル
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {groups
              .filter((g) => !g.isRunningSection && !g.isPinnedSection)
              .map((group) => {
                const proj = group.project;
                const groupKey = proj ? `proj:${proj.id}` : group.name;
                const totalCount = group.conversations.length;
                const isGroupCollapsed = collapsed[groupKey] ?? false;
                const isExpanded = expanded[groupKey] ?? false;
                const visibleItems = isExpanded
                  ? group.conversations
                  : group.conversations.slice(0, PREVIEW_COUNT);
                const hiddenCount = totalCount - PREVIEW_COUNT;

                return (
                  <div
                    key={groupKey}
                    className={`workspace-group ${proj ? "project-workspace-group" : ""}`}
                  >
                    {proj ? (
                      <div
                        className={`workspace-group-header project-group-header ${isGroupCollapsed ? "is-collapsed" : ""}`}
                        onClick={() => toggleGroup(groupKey)}
                        title={
                          proj.folderPath
                            ? `${proj.name} (${proj.folderPath})`
                            : proj.name
                        }
                      >
                        <span
                          className={`workspace-group-chevron ${isGroupCollapsed ? "collapsed" : ""}`}
                        >
                          ▾
                        </span>
                        <span
                          className="sidebar-project-folder-icon"
                          aria-hidden="true"
                        >
                          <IconFolder size={13} />
                        </span>
                        <span className="workspace-group-name">{proj.name}</span>
                        {totalCount > 0 && (
                          <span className="workspace-group-count">
                            {totalCount}
                          </span>
                        )}
                        <div
                          className="sidebar-project-row-actions"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="sidebar-project-menu-wrap">
                            <button
                              type="button"
                              className="sidebar-project-row-btn"
                              title="プロジェクトメニュー"
                              aria-label={`${proj.name}のメニュー`}
                              onClick={() =>
                                setProjectMenuId((cur) =>
                                  cur === proj.id ? null : proj.id,
                                )
                              }
                            >
                              <IconMore size={13} />
                            </button>
                            {projectMenuId === proj.id && (
                              <div
                                className="sidebar-project-dropdown"
                                role="menu"
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="sidebar-project-dropdown-item"
                                  onClick={() => {
                                    setProjectMenuId(null);
                                    if (onNewInProject) onNewInProject(proj);
                                    else onNew();
                                  }}
                                >
                                  新規チャットを作成
                                </button>
                                {proj.folderPath && (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="sidebar-project-dropdown-item"
                                    onClick={() => {
                                      void navigator.clipboard?.writeText(
                                        proj.folderPath!,
                                      );
                                      setProjectMenuId(null);
                                    }}
                                  >
                                    パスをコピー
                                  </button>
                                )}
                                {!proj.isDefaultCli && (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="sidebar-project-dropdown-item danger"
                                    onClick={() => void handleDeleteProject(proj)}
                                  >
                                    プロジェクトを削除
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            className="sidebar-project-row-btn"
                            title={`${proj.name}で新規チャットを作成`}
                            aria-label={`${proj.name}で新規チャット`}
                            onClick={() => {
                              if (onNewInProject) onNewInProject(proj);
                              else onNew();
                            }}
                          >
                            <IconPlus size={13} />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="workspace-group-header"
                        onClick={() => toggleGroup(groupKey)}
                      >
                        <span
                          className={`workspace-group-chevron ${isGroupCollapsed ? "collapsed" : ""}`}
                        >
                          ▾
                        </span>
                        <span className="workspace-group-name">{group.name}</span>
                        {group.hasRunning && (
                          <IconSpinner
                            size={12}
                            className="sidebar-running-spinner"
                          />
                        )}
                        <span className="workspace-group-count">
                          {totalCount}
                        </span>
                      </button>
                    )}

                    {!isGroupCollapsed && (
                      <div className="workspace-group-items">
                        {proj && totalCount === 0 ? (
                          <div className="sidebar-project-empty">
                            まだ会話はありません
                          </div>
                        ) : (
                          visibleItems.map(renderItem)
                        )}

                        {hiddenCount > 0 && (
                          <button
                            className="see-all-btn"
                            onClick={() => toggleExpanded(groupKey)}
                          >
                            {isExpanded
                              ? "折りたたむ"
                              : `すべて表示 (${totalCount}件)`}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
          </>
        )}
      </div>
      </div>

      {/* Search Modal */}
      {searchOpen && (
        <div className="search-modal-overlay" onClick={closeSearch}>
          <div
            className="search-modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
            }}
          >
            <div className="search-modal-header">
              <IconSearch size={16} className="search-modal-icon" />
              <input
                ref={searchInputRef}
                className="search-modal-input"
                type="text"
                placeholder="会話を検索..."
                value={searchQuery}
                onChange={(e) => handleSearchInput(e.target.value)}
                autoFocus
              />
              <button className="search-modal-close" onClick={closeSearch}>
                <IconX size={13} />
              </button>
            </div>
            <div className="search-modal-results">
              {searching ? (
                <div className="search-modal-status">
                  <div className="loading-spinner" />
                </div>
              ) : searchResults === null ? (
                <div className="search-modal-status">
                  キーワードを入力して全会話を横断検索できます
                </div>
              ) : searchResults.length === 0 ? (
                <div className="search-modal-status">
                  「{searchQuery}」に一致する会話はありません
                </div>
              ) : (
                searchResults.map((result) => {
                  const matchedConv = conversationById.get(result.id);
                  const searchBadge = formatCompactModelBadge(
                    result.modelLabel ?? matchedConv?.summary.modelLabel,
                    result.modelProvider ?? matchedConv?.summary.modelProvider,
                  );
                  return (
                    <button
                      key={result.id}
                      className="search-result-item"
                      onClick={() => {
                        onSelect(result.id);
                        closeSearch();
                      }}
                    >
                      <div className="search-result-title">{result.title}</div>
                      <div className="search-result-snippets">
                        {result.snippets.map((s, i) => (
                          <div key={i} className="search-result-snippet">
                            {s}
                          </div>
                        ))}
                      </div>
                      <div className="search-result-meta">
                        {searchBadge && (
                          <span
                            className={`sidebar-model-badge compact provider-${searchBadge.provider}`}
                            title={`使用モデル: ${searchBadge.fullLabel}`}
                            data-testid="search-result-model-badge"
                          >
                            <span
                              className="sidebar-model-dot"
                              aria-hidden="true"
                            />
                            <span className="sidebar-model-badge-text">
                              {searchBadge.text}
                            </span>
                          </span>
                        )}
                        <span>{result.matchCount}件一致</span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
