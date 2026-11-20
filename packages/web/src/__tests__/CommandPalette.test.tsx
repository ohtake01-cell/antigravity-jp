import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../components/CommandPalette";
import { api } from "../api/client";
import type { ConversationEntry } from "../hooks/useConversations";
import type {
  CommandApprovalItem,
  CommandChatItem,
} from "../types";

vi.mock("../api/client", () => ({
  api: {
    recentWorkbenchFiles: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

const SAMPLE_CONVS: ConversationEntry[] = [
  {
    id: "conv-1",
    summary: {
      trajectoryId: "traj-1",
      summary: "Antigravity 日本語版チューニング",
      stepCount: 12,
      lastModifiedTime: "2026-11-20T08:00:00Z",
      createdTime: "2026-11-20T07:00:00Z",
      status: "CASCADE_RUN_STATUS_RUNNING",
      workspaces: [],
      modelLabel: "Gemini 4 Neon (High)",
    },
  },
  {
    id: "conv-2",
    summary: {
      trajectoryId: "traj-2",
      summary: "別テーマの設計メモ",
      stepCount: 5,
      lastModifiedTime: "2026-11-19T12:00:00Z",
      createdTime: "2026-11-19T11:00:00Z",
      status: "CASCADE_RUN_STATUS_IDLE",
      workspaces: [],
    },
  },
];

const SAMPLE_WORKERS: CommandChatItem[] = [
  {
    id: "worker-1",
    kind: "worker_session",
    provider: "ollama",
    title: "0円ローカル下調べ",
    status: "running",
    model: "qwen3.8:27b-ud-q4",
    modelLabel: "qwen3.8:27b-ud-q4",
    updatedAt: "2026-11-20T08:01:00Z",
  },
];

const SAMPLE_APPROVALS: CommandApprovalItem[] = [
  {
    id: "app-1",
    kind: "exec_command",
    provider: "codex",
    title: "本番キャッシュ削除",
    summary: "rm -rf /tmp/cache を実行確認",
    status: "pending",
    createdAt: "2026-11-20T08:02:00Z",
  },
];

describe("CommandPalette (⌘K)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.recentWorkbenchFiles.mockResolvedValue({
      ok: true,
      files: [
        {
          name: "design.md",
          path: "/Users/demo/project/design.md",
          kind: "markdown",
          size: 1200,
          mtime: "2026-11-20T07:50:00Z",
          source: "workspace",
        },
      ],
    });
  });

  function renderPalette(
    overrides: Partial<React.ComponentProps<typeof CommandPalette>> = {},
  ) {
    const props: React.ComponentProps<typeof CommandPalette> = {
      isOpen: true,
      onClose: vi.fn(),
      conversations: SAMPLE_CONVS,
      workerChats: SAMPLE_WORKERS,
      pendingApprovals: SAMPLE_APPROVALS,
      canBranchSideChat: true,
      workbenchOpen: false,
      onNewChat: vi.fn(),
      onSelectChat: vi.fn(),
      onOpenCommandTab: vi.fn(),
      onOpenWorkerSession: vi.fn(),
      onOpenSettings: vi.fn(),
      onToggleWorkbench: vi.fn(),
      onOpenFileInWorkbench: vi.fn(),
      onOpenSideChat: vi.fn(),
      onTriggerVoice: vi.fn(),
      onQuickDispatch: vi.fn(),
      ...overrides,
    };
    const res = render(<CommandPalette {...props} />);
    return { ...res, props };
  }

  it("surfaces pending approvals first and opens Safety tab on Enter", async () => {
    const { props } = renderPalette();
    const input = screen.getByLabelText("クイック司令検索");

    expect(screen.getByText("🛡️ 承認待ち（優先）")).toBeInTheDocument();
    expect(screen.getByText("承認確認: 本番キャッシュ削除")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onOpenCommandTab).toHaveBeenCalledWith("safety");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Enter and Escape while Japanese IME composition is active", async () => {
    const { props } = renderPalette();
    const input = screen.getByLabelText("クイック司令検索");

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });

    expect(props.onOpenCommandTab).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("implements 2-step Escape: first clears query, second closes palette", async () => {
    const { props } = renderPalette();
    const input = screen.getByLabelText("クイック司令検索");

    await userEvent.type(input, "muse");
    expect(input).toHaveValue("muse");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(props.onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("offers instant AI dispatch actions for typed instruction text and opens recent files", async () => {
    const { props } = renderPalette({ pendingApprovals: [] });

    // Recent file loads and opens in workbench
    const recentBtn = await screen.findByText("design.md");
    await userEvent.click(recentBtn);
    expect(props.onOpenFileInWorkbench).toHaveBeenCalledWith(
      "/Users/demo/project/design.md",
    );

    // Re-open with typed instruction -> dispatches directly to Gemini
    const { props: props2 } = renderPalette({ pendingApprovals: [] });
    const inputs = screen.getAllByLabelText("クイック司令検索");
    const input2 = inputs[inputs.length - 1];
    await userEvent.type(input2, "ログの要約を作って");

    const geminiDispatch = await screen.findByText(
      /Gemini で新規チャット開始/,
    );
    await userEvent.click(geminiDispatch);
    await waitFor(() => {
      expect(props2.onQuickDispatch).toHaveBeenCalledWith(
        "antigravity",
        "ログの要約を作って",
      );
    });
  });
});
