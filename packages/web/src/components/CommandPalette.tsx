import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { api } from "../api/client";
import type { ConversationEntry } from "../hooks/useConversations";
import type {
  CommandApprovalItem,
  CommandChatItem,
  ProviderId,
  WorkbenchRecentFileItem,
} from "../types";

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  conversations: ConversationEntry[];
  workerChats?: CommandChatItem[];
  pendingApprovals?: CommandApprovalItem[];
  canBranchSideChat?: boolean;
  workbenchOpen?: boolean;
  onNewChat: () => void;
  onSelectChat: (cascadeId: string) => void;
  onOpenCommandTab?: (tab: "control" | "brain" | "memory" | "safety") => void;
  onOpenWorkerSession?: (sessionId: string) => void;
  onOpenSettings: () => void;
  onToggleWorkbench: () => void;
  onOpenFileInWorkbench: (filePath: string) => void;
  onOpenSideChat: () => void;
  onTriggerVoice: () => void;
  onQuickDispatch: (provider: ProviderId, prompt: string) => Promise<void> | void;
}

interface PaletteItem {
  id: string;
  group: "approval" | "action" | "chat" | "file" | "dispatch";
  icon: string;
  title: string;
  subtitle?: string;
  shortcut?: string;
  badge?: string;
  badgeTone?: "warn" | "live" | "muted";
  keywords: string;
  onSelect: () => void | Promise<void>;
}

const GROUP_LABELS: Record<PaletteItem["group"], string> = {
  approval: "🛡️ 承認待ち（優先）",
  action: "⚡ クイック操作",
  chat: "💬 チャット",
  file: "📄 最近のファイル（右ペインで開く）",
  dispatch: "🤖 入力文をそのままAIへ即指示",
};

const GROUP_ORDER: PaletteItem["group"][] = [
  "approval",
  "action",
  "chat",
  "file",
  "dispatch",
];

function scoreFuzzyMatch(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return 1;
  if (h === n) return 100;
  if (h.startsWith(n)) return 85;
  const idx = h.indexOf(n);
  if (idx >= 0) return Math.max(40, 75 - idx * 0.5);

  // Ordered subsequence fuzzy match (e.g. "shn" -> "shonin", "ed" -> "editor")
  let qi = 0;
  let score = 20;
  let consecutive = 0;
  for (let i = 0; i < h.length && qi < n.length; i++) {
    if (h[i] === n[qi]) {
      qi += 1;
      consecutive += 1;
      score += consecutive * 2;
    } else {
      consecutive = 0;
    }
  }
  return qi === n.length ? score : 0;
}

function matchesQuery(item: PaletteItem, rawQuery: string): number {
  const trimmed = rawQuery.trim();
  if (!trimmed) return 1;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const haystack = `${item.title} ${item.subtitle ?? ""} ${item.keywords}`;
  let total = 0;
  for (const token of tokens) {
    const s = scoreFuzzyMatch(haystack, token);
    if (s <= 0) return 0;
    total += s;
  }
  return total;
}

export function CommandPalette({
  isOpen,
  onClose,
  conversations,
  workerChats = [],
  pendingApprovals = [],
  canBranchSideChat = false,
  workbenchOpen = false,
  onNewChat,
  onSelectChat,
  onOpenCommandTab,
  onOpenWorkerSession,
  onOpenSettings,
  onToggleWorkbench,
  onOpenFileInWorkbench,
  onOpenSideChat,
  onTriggerVoice,
  onQuickDispatch,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentFiles, setRecentFiles] = useState<WorkbenchRecentFileItem[]>([]);
  const [dispatchBusyId, setDispatchBusyId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const isComposingRef = useRef(false);

  // Reset state & immediately focus input when opened
  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setActiveIndex(0);
    setDispatchBusyId(null);
    isComposingRef.current = false;

    const raf = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });

    // Quietly refresh recent files when palette opens
    let cancelled = false;
    api
      .recentWorkbenchFiles()
      .then((res) => {
        if (!cancelled && Array.isArray(res?.files)) {
          setRecentFiles(res.files);
        }
      })
      .catch(() => {
        // Non-fatal
      });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
  }, [isOpen]);

  const allItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];

    // 1. Pending approvals (surfaced first when present)
    for (const approval of pendingApprovals) {
      items.push({
        id: `approval:${approval.id}`,
        group: "approval",
        icon: "🛡️",
        title: `承認確認: ${approval.title}`,
        subtitle: approval.summary,
        badge: "承認待ち",
        badgeTone: "warn",
        keywords: `approval shonin 承認 許可 安全 ${approval.provider} ${approval.target ?? ""}`,
        onSelect: () => {
          onOpenCommandTab?.("safety");
          onClose();
        },
      });
    }

    // 2. Quick Actions
    items.push(
      {
        id: "act:new-chat",
        group: "action",
        icon: "✨",
        title: "新しいチャットを開始",
        subtitle: "通常チャット画面で新規会話を立ち上げる",
        keywords: "new chat 新規 チャット 作成",
        onSelect: () => {
          onNewChat();
          onClose();
        },
      },
      {
        id: "act:voice",
        group: "action",
        icon: "🎙️",
        title: "音声で指示する",
        subtitle: "マイク録音を開始してそのまま指示入力",
        shortcut: "⌃⌥M",
        keywords: "voice mic 音声 マイク 録音 話す",
        onSelect: () => {
          onClose();
          onTriggerVoice();
        },
      },
      {
        id: "act:workbench",
        group: "action",
        icon: "📄",
        title: workbenchOpen
          ? "右ペインエディタを閉じる"
          : "右ペインエディタを開く",
        subtitle: "Markdown編集・Mermaid図・CSV・PDF・画像ビューア",
        keywords: "editor workbench file エディタ ビューア ファイル 開く",
        onSelect: () => {
          onToggleWorkbench();
          onClose();
        },
      },
    );

    if (canBranchSideChat) {
      items.push({
        id: "act:side-chat",
        group: "action",
        icon: "🌿",
        title: "枝分かれサイドチャットを開く",
        subtitle: "本流の記憶を汚さずに別案を検証する",
        keywords: "branch side chat 枝分かれ 分岐 検証",
        onSelect: () => {
          onClose();
          onOpenSideChat();
        },
      });
    }

    items.push({
      id: "act:settings",
      group: "action",
      icon: "⚙️",
      title: "設定を開く",
      subtitle: "デフォルトモデル・アーカイブ・通知設定",
      keywords: "settings config 設定 モデル 通知 アーカイブ",
      onSelect: () => {
        onOpenSettings();
        onClose();
      },
    });

    // 3. Worker sessions & Antigravity chats
    const sortedWorkers = [...workerChats]
      .filter((c) => c.kind === "worker_session" && c.status !== "archived")
      .slice(0, 8);
    for (const w of sortedWorkers) {
      items.push({
        id: `worker:${w.id}`,
        group: "chat",
        icon: w.status === "running" ? "⚡" : "🤖",
        title: w.title || "ワーカーセッション",
        subtitle: `${w.provider}${w.modelLabel ? ` · ${w.modelLabel}` : ""}`,
        badge: w.status === "running" ? "実行中" : w.provider,
        badgeTone: w.status === "running" ? "live" : "muted",
        keywords: `worker session ワーカー ${w.provider} ${w.modelLabel ?? ""} ${w.lastMessagePreview ?? ""}`,
        onSelect: () => {
          onOpenWorkerSession?.(w.id);
          onClose();
        },
      });
    }

    const sortedConvs = [...conversations]
      .sort((a, b) => {
        const aRun = a.summary.status === "CASCADE_RUN_STATUS_RUNNING" ? 1 : 0;
        const bRun = b.summary.status === "CASCADE_RUN_STATUS_RUNNING" ? 1 : 0;
        if (aRun !== bRun) return bRun - aRun;
        return (b.summary.lastModifiedTime ?? "").localeCompare(
          a.summary.lastModifiedTime ?? "",
        );
      })
      .slice(0, 14);

    for (const conv of sortedConvs) {
      const running = conv.summary.status === "CASCADE_RUN_STATUS_RUNNING";
      items.push({
        id: `chat:${conv.id}`,
        group: "chat",
        icon: running ? "⚡" : "💬",
        title: conv.summary.summary || "無題のチャット",
        subtitle: conv.summary.modelLabel ?? "Antigravity チャット",
        badge: running ? "実行中" : undefined,
        badgeTone: "live",
        keywords: `chat conversation チャット 会話 ${conv.summary.modelLabel ?? ""}`,
        onSelect: () => {
          onSelectChat(conv.id);
          onClose();
        },
      });
      for (const child of conv.summary.subagents ?? []) {
        const childRunning = child.status === "CASCADE_RUN_STATUS_RUNNING";
        items.push({
          id: `subagent:${child.id}`,
          group: "chat",
          icon: childRunning ? "⚡" : "🤖",
          title: `↳ ${child.role}`,
          subtitle: `子チャット · 親: ${conv.summary.summary || "チャット"}${child.modelLabel ? ` · ${child.modelLabel}` : ""}`,
          badge: childRunning ? "実行中" : child.typeName || "子チャット",
          badgeTone: childRunning ? "live" : "muted",
          keywords: `subagent child 子チャット サブエージェント ${child.role} ${child.typeName} ${conv.summary.summary ?? ""} ${child.modelLabel ?? ""}`,
          onSelect: () => {
            onSelectChat(child.id);
            onClose();
          },
        });
      }
    }

    // 4. Recent files -> open in right-pane Artifact Workbench
    for (const file of recentFiles.slice(0, 6)) {
      items.push({
        id: `file:${file.path}`,
        group: "file",
        icon: "📄",
        title: file.name,
        subtitle: file.path,
        keywords: `file recent ファイル ${file.name} ${file.path}`,
        onSelect: () => {
          onOpenFileInWorkbench(file.path);
          onClose();
        },
      });
    }

    return items;
  }, [
    pendingApprovals,
    workbenchOpen,
    canBranchSideChat,
    workerChats,
    conversations,
    recentFiles,
    onClose,
    onNewChat,
    onOpenCommandTab,
    onOpenWorkerSession,
    onSelectChat,
    onOpenSettings,
    onToggleWorkbench,
    onOpenFileInWorkbench,
    onOpenSideChat,
    onTriggerVoice,
  ]);

  const filteredItems = useMemo<PaletteItem[]>(() => {
    const trimmed = query.trim();
    const matched = trimmed
      ? allItems
          .map((item) => ({ item, score: matchesQuery(item, trimmed) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.item)
      : allItems;

    // When the user types a real instruction (>= 2 chars), surface instant AI dispatch actions
    const dispatchItems: PaletteItem[] =
      trimmed.length >= 2
        ? [
            {
              id: "dispatch:antigravity",
              group: "dispatch",
              icon: "✨",
              title: `Gemini で新規チャット開始: 「${trimmed.slice(0, 36)}${trimmed.length > 36 ? "…" : ""}」`,
              subtitle: "新しい会話を作成してそのまま送信",
              keywords: trimmed,
              onSelect: async () => {
                setDispatchBusyId("dispatch:antigravity");
                try {
                  await onQuickDispatch("antigravity", trimmed);
                  onClose();
                } finally {
                  setDispatchBusyId(null);
                }
              },
            },
          ]
        : [];

    // Order by semantic groups while preserving match ranking inside each group
    const combined = [...matched, ...dispatchItems];
    const ordered: PaletteItem[] = [];
    for (const group of GROUP_ORDER) {
      for (const item of combined) {
        if (item.group === group) {
          ordered.push(item);
        }
      }
    }
    return ordered;
  }, [allItems, query, onQuickDispatch, onClose]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    const activeEl = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-index="${activeIndex}"]`,
    );
    activeEl?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, isOpen]);

  const executeItem = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item || dispatchBusyId) return;
      void item.onSelect();
    },
    [dispatchBusyId],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      // Strictly guard Japanese IME composition so kanji conversion Enter/Esc never misfires
      if (
        isComposingRef.current ||
        e.nativeEvent.isComposing ||
        e.keyCode === 229
      ) {
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        if (query.trim().length > 0) {
          setQuery("");
          setActiveIndex(0);
        } else {
          onClose();
        }
        return;
      }

      if (filteredItems.length === 0) return;

      if (e.key === "ArrowDown" || (e.ctrlKey && e.key.toLowerCase() === "n")) {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % filteredItems.length);
        return;
      }

      if (e.key === "ArrowUp" || (e.ctrlKey && e.key.toLowerCase() === "p")) {
        e.preventDefault();
        setActiveIndex(
          (prev) => (prev - 1 + filteredItems.length) % filteredItems.length,
        );
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        executeItem(filteredItems[activeIndex]);
      }
    },
    [query, filteredItems, activeIndex, executeItem, onClose],
  );

  if (!isOpen) return null;

  // Build grouped render segments with flat index tracking
  let runningIdx = 0;
  const sections: Array<{
    group: PaletteItem["group"];
    label: string;
    entries: Array<{ item: PaletteItem; flatIndex: number }>;
  }> = [];

  for (const group of GROUP_ORDER) {
    const groupItems = filteredItems.filter((i) => i.group === group);
    if (groupItems.length === 0) continue;
    sections.push({
      group,
      label: GROUP_LABELS[group],
      entries: groupItems.map((item) => ({ item, flatIndex: runningIdx++ })),
    });
  }

  return (
    <div
      className="cmd-palette-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="cmd-palette-modal"
        role="dialog"
        aria-modal="true"
        aria-label="クイック司令パレット"
      >
        <div className="cmd-palette-input-row">
          <span className="cmd-palette-search-icon" aria-hidden="true">
            ⌘
          </span>
          <input
            ref={inputRef}
            type="text"
            className="cmd-palette-input"
            placeholder="チャット検索・タブ切替・ファイルを開く・または指示文を入力…"
            aria-label="クイック司令検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onKeyDown={handleKeyDown}
          />
          {query && (
            <button
              type="button"
              className="cmd-palette-clear-btn"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label="検索をクリア"
            >
              ✕
            </button>
          )}
        </div>

        <div
          className="cmd-palette-list"
          ref={listRef}
          role="listbox"
          aria-label="コマンド候補一覧"
        >
          {sections.length === 0 ? (
            <div className="cmd-palette-empty">
              一致する項目が見つかりません
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.group} className="cmd-palette-group">
                <div className="cmd-palette-group-label">{section.label}</div>
                {section.entries.map(({ item, flatIndex }) => {
                  const isActive = flatIndex === activeIndex;
                  const isBusy = dispatchBusyId === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      data-palette-index={flatIndex}
                      className={`cmd-palette-item ${isActive ? "active" : ""}`}
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      onClick={() => executeItem(item)}
                      disabled={Boolean(dispatchBusyId)}
                    >
                      <span className="cmd-palette-item-icon" aria-hidden="true">
                        {item.icon}
                      </span>
                      <span className="cmd-palette-item-body">
                        <span className="cmd-palette-item-title">
                          {isBusy ? "起動中… " : ""}
                          {item.title}
                        </span>
                        {item.subtitle && (
                          <span className="cmd-palette-item-sub">
                            {item.subtitle}
                          </span>
                        )}
                      </span>
                      {item.badge && (
                        <span
                          className={`cmd-palette-badge tone-${item.badgeTone ?? "muted"}`}
                        >
                          {item.badge}
                        </span>
                      )}
                      {item.shortcut && (
                        <kbd className="cmd-palette-kbd">{item.shortcut}</kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="cmd-palette-footer" aria-hidden="true">
          <span>
            <kbd>↑↓</kbd> 移動
          </span>
          <span>
            <kbd>↵</kbd> 実行
          </span>
          <span>
            <kbd>Esc</kbd> {query ? "クリア" : "閉じる"}
          </span>
          <span className="cmd-palette-footer-spacer" />
          <span>日本語IME変換安全対応</span>
        </div>
      </div>
    </div>
  );
}
