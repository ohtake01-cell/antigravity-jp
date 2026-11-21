import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar, formatCompactModelBadge } from "../components/Sidebar";
import type { ConversationEntry } from "../hooks/useConversations";

vi.mock("../api/client", () => ({
  api: {
    updateAnnotations: vi.fn().mockResolvedValue({ ok: true }),
    search: vi.fn(),
    projects: vi.fn().mockResolvedValue({ projects: [] }),
    createProject: vi.fn(),
    deleteProject: vi.fn().mockResolvedValue({ ok: true }),
    assignConversationProject: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

describe("Sidebar", () => {
  it(
    "shows both loaded and unloaded non-archived conversations while hiding archived ones",
    { timeout: 30_000 },
    () => {
    const conversations: ConversationEntry[] = [
      {
        id: "conv-active",
        summary: {
          summary: "稼働中チャット",
          stepCount: 15,
          status: "CASCADE_RUN_STATUS_IDLE",
          lastModifiedTime: "2026-11-18T18:00:00.000Z",
          createdTime: "2026-11-18T17:00:00.000Z",
          trajectoryId: "t-1",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
        },
      },
      {
        id: "conv-unloaded",
        summary: {
          summary: "ディスク待機チャット",
          stepCount: 0,
          status: "CASCADE_RUN_STATUS_UNLOADED",
          lastModifiedTime: "2026-11-18T17:30:00.000Z",
          createdTime: "2026-11-18T17:00:00.000Z",
          trajectoryId: "",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
        },
      },
      {
        id: "conv-archived",
        summary: {
          summary: "アーカイブ済みチャット",
          stepCount: 20,
          status: "CASCADE_RUN_STATUS_UNLOADED",
          lastModifiedTime: "2026-11-18T16:00:00.000Z",
          createdTime: "2026-11-18T15:00:00.000Z",
          trajectoryId: "t-3",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
          annotations: { archived: true },
        },
      },
    ];

    render(
      <Sidebar
        conversations={conversations}
        activeId="conv-active"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onDelete={vi.fn()}
        onSettings={vi.fn()}
        loading={false}
        connected={true}
        isOpen={true}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("稼働中チャット")).toBeInTheDocument();
    expect(screen.getByText("ディスク待機チャット")).toBeInTheDocument();
    expect(screen.queryByText("アーカイブ済みチャット")).not.toBeInTheDocument();
  });

  it("promotes running conversations to the top section above pinned chats and renders child subagents", () => {
    const onSelect = vi.fn();
    const conversations: ConversationEntry[] = [
      {
        id: "conv-pinned",
        summary: {
          summary: "ピン留め待機チャット",
          stepCount: 10,
          status: "CASCADE_RUN_STATUS_IDLE",
          lastModifiedTime: "2026-11-19T02:00:00.000Z",
          createdTime: "2026-11-19T01:00:00.000Z",
          trajectoryId: "t-pin",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
          annotations: { pinned: true },
        },
      },
      {
        id: "conv-running",
        summary: {
          summary: "いま動いているチャット",
          stepCount: 25,
          status: "CASCADE_RUN_STATUS_RUNNING",
          lastModifiedTime: "2026-11-19T01:30:00.000Z",
          createdTime: "2026-11-19T01:00:00.000Z",
          trajectoryId: "t-run",
          workspaces: [],
          hasRunningSubagent: true,
          subagents: [
            {
              id: "child-1",
              role: "調査ワーカー",
              typeName: "research",
              status: "CASCADE_RUN_STATUS_RUNNING",
              lastModifiedTime: "2026-11-19T01:31:00.000Z",
            },
          ],
        },
      },
    ];

    const { container } = render(
      <Sidebar
        conversations={conversations}
        activeId="conv-pinned"
        onSelect={onSelect}
        onNew={vi.fn()}
        onDelete={vi.fn()}
        onSettings={vi.fn()}
        loading={false}
        connected={true}
        isOpen={true}
        onToggle={vi.fn()}
      />,
    );

    const groupHeaders = Array.from(
      container.querySelectorAll(".workspace-group-name"),
    ).map((el) => el.textContent);
    expect(groupHeaders[0]).toBe("⚡ 実行中");
    expect(groupHeaders[1]).toBe("📌 ピン留め");

    // Collapsed by default; expands on tap
    expect(screen.queryByText("調査ワーカー")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/エージェント稼働中 \(1件\)/));

    const childBtn = screen.getByText("調査ワーカー");
    expect(childBtn).toBeInTheDocument();
    fireEvent.click(childBtn);
    expect(onSelect).toHaveBeenCalledWith("child-1");
  });

  it("formats and renders compact provider-colored model badges for idle and running chats", () => {
    expect(formatCompactModelBadge("Gemini 4 Neon (High)")).toEqual({
      text: "Neon · High",
      provider: "google",
      fullLabel: "Gemini 4 Neon (High)",
    });
    expect(formatCompactModelBadge("Gemini 4 Carbon (Medium)")).toEqual({
      text: "Carbon · Med",
      provider: "google",
      fullLabel: "Gemini 4 Carbon (Medium)",
    });
    expect(formatCompactModelBadge("Orchestrator (Neon)")).toEqual({
      text: "Orch · Neon",
      provider: "google",
      fullLabel: "Orchestrator (Neon)",
    });
    expect(formatCompactModelBadge("Claude Opus 5.5 (High)")).toEqual({
      text: "Opus 5.5 · High",
      provider: "anthropic",
      fullLabel: "Claude Opus 5.5 (High)",
    });
    expect(formatCompactModelBadge("GPT-OSS 120B (Medium)")).toEqual({
      text: "GPT-OSS 120B",
      provider: "openai",
      fullLabel: "GPT-OSS 120B (Medium)",
    });
    expect(formatCompactModelBadge("qwen3.8:27b")).toEqual({
      text: "Qwen 27B",
      provider: "ollama",
      fullLabel: "qwen3.8:27b",
    });
    expect(formatCompactModelBadge("MODEL_PLACEHOLDER_M532")).toBeNull();

    const conversations: ConversationEntry[] = [
      {
        id: "conv-running-neon",
        summary: {
          summary: "実行中ネオン",
          stepCount: 42,
          status: "CASCADE_RUN_STATUS_RUNNING",
          lastModifiedTime: "2026-11-19T12:00:00.000Z",
          createdTime: "2026-11-19T11:00:00.000Z",
          trajectoryId: "t-neon",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
          modelLabel: "Gemini 4 Neon (High)",
          modelProvider: "google",
        },
      },
      {
        id: "conv-idle-claude",
        summary: {
          summary: "待機クロード",
          stepCount: 12,
          status: "CASCADE_RUN_STATUS_IDLE",
          lastModifiedTime: "2026-11-19T11:50:00.000Z",
          createdTime: "2026-11-19T11:00:00.000Z",
          trajectoryId: "t-claude",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
          modelLabel: "Claude Opus 5.5 (High)",
          modelProvider: "anthropic",
        },
      },
    ];

    render(
      <Sidebar
        conversations={conversations}
        activeId="conv-running-neon"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onDelete={vi.fn()}
        onSettings={vi.fn()}
        loading={false}
        connected={true}
        isOpen={true}
        onToggle={vi.fn()}
      />,
    );

    const badges = screen.getAllByTestId("sidebar-model-badge");
    expect(badges).toHaveLength(2);
    expect(badges[0]).toHaveTextContent("Neon · High");
    expect(badges[0]).toHaveClass("provider-google");
    expect(badges[0]).toHaveAttribute("title", "使用モデル: Gemini 4 Neon (High)");

    expect(badges[1]).toHaveTextContent("Opus 5.5 · High");
    expect(badges[1]).toHaveClass("provider-anthropic");
    expect(badges[1]).toHaveAttribute("title", "使用モデル: Claude Opus 5.5 (High)");
  });

  it("renders compact model badges on child subagent rows and search results", async () => {
    const { api } = await import("../api/client");
    vi.mocked(api.search).mockResolvedValueOnce({
      query: "テスト",
      results: [
        {
          id: "conv-parent-1",
          title: "親チャット",
          snippets: ["テスト結果"],
          matchCount: 2,
          modelLabel: "Gemini 4 Neon (XHigh)",
          modelProvider: "google",
        },
      ],
      totalConversations: 1,
      elapsedMs: 12,
    });

    const conversations: ConversationEntry[] = [
      {
        id: "conv-parent-1",
        summary: {
          summary: "親チャット",
          stepCount: 20,
          status: "CASCADE_RUN_STATUS_RUNNING",
          lastModifiedTime: "2026-11-19T13:00:00.000Z",
          createdTime: "2026-11-19T12:00:00.000Z",
          trajectoryId: "t-p1",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
          modelLabel: "Gemini 4 Neon (XHigh)",
          modelProvider: "google",
          hasRunningSubagent: true,
          subagents: [
            {
              id: "sub-child-1",
              role: "調査ワーカー",
              typeName: "research",
              status: "CASCADE_RUN_STATUS_RUNNING",
              lastModifiedTime: "2026-11-19T13:01:00.000Z",
              modelLabel: "Gemini 3.8 Flash (High)",
              modelProvider: "google",
            },
          ],
        },
      },
    ];

    render(
      <Sidebar
        conversations={conversations}
        activeId="conv-parent-1"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onDelete={vi.fn()}
        onSettings={vi.fn()}
        loading={false}
        connected={true}
        isOpen={true}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("sidebar-subagent-model-badge")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/エージェント稼働中 \(1件\)/));

    const subBadge = screen.getByTestId("sidebar-subagent-model-badge");
    expect(subBadge).toHaveTextContent("Flash 3.8 · High");
    expect(subBadge).toHaveClass("provider-google");

    fireEvent.click(screen.getByText("検索"));
    const input = screen.getByPlaceholderText("会話を検索...");
    fireEvent.change(input, { target: { value: "テスト" } });

    const searchBadge = await screen.findByTestId("search-result-model-badge");
    expect(searchBadge).toHaveTextContent("Neon · XHigh");
    expect(searchBadge).toHaveClass("provider-google");
  });

  it("shows smart provider filter strip only when 2+ model providers exist and filters conversations", () => {
    const multiProviderConvs: ConversationEntry[] = [
      {
        id: "conv-g",
        summary: {
          summary: "Geminiの仕事",
          stepCount: 10,
          status: "CASCADE_RUN_STATUS_IDLE",
          lastModifiedTime: "2026-11-19T13:00:00.000Z",
          createdTime: "2026-11-19T12:00:00.000Z",
          trajectoryId: "t-g",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
          modelLabel: "Gemini 4 Neon (High)",
          modelProvider: "google",
        },
      },
      {
        id: "conv-c",
        summary: {
          summary: "Claudeのレビュー",
          stepCount: 8,
          status: "CASCADE_RUN_STATUS_IDLE",
          lastModifiedTime: "2026-11-19T12:50:00.000Z",
          createdTime: "2026-11-19T12:00:00.000Z",
          trajectoryId: "t-c",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
          modelLabel: "Claude Opus 5.5 (High)",
          modelProvider: "anthropic",
        },
      },
    ];

    const { rerender } = render(
      <Sidebar
        conversations={[multiProviderConvs[0]]}
        activeId="conv-g"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onDelete={vi.fn()}
        onSettings={vi.fn()}
        loading={false}
        connected={true}
        isOpen={true}
        onToggle={vi.fn()}
      />,
    );
    // Single provider -> filter strip stays hidden
    expect(screen.queryByTestId("sidebar-provider-filter")).not.toBeInTheDocument();

    // Multi provider -> filter strip appears
    rerender(
      <Sidebar
        conversations={multiProviderConvs}
        activeId="conv-g"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onDelete={vi.fn()}
        onSettings={vi.fn()}
        loading={false}
        connected={true}
        isOpen={true}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByTestId("sidebar-provider-filter")).toBeInTheDocument();
    expect(screen.getByText("Geminiの仕事")).toBeInTheDocument();
    expect(screen.getByText("Claudeのレビュー")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Claude/ }));
    expect(screen.queryByText("Geminiの仕事")).not.toBeInTheDocument();
    expect(screen.getByText("Claudeのレビュー")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "すべて" }));
    expect(screen.getByText("Geminiの仕事")).toBeInTheDocument();
    expect(screen.getByText("Claudeのレビュー")).toBeInTheDocument();
  });

  it("shows idle child subagents expanded by default and filters via subagent pill", () => {
    const onSelect = vi.fn();
    const conversations: ConversationEntry[] = [
      {
        id: "conv-with-child",
        summary: {
          summary: "親チャットA",
          stepCount: 15,
          status: "CASCADE_RUN_STATUS_IDLE",
          lastModifiedTime: "2026-11-20T02:00:00.000Z",
          createdTime: "2026-11-20T01:00:00.000Z",
          trajectoryId: "t-a",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
          subagents: [
            {
              id: "child-idle-1",
              role: "画面チェッカー",
              typeName: "browser",
              status: "CASCADE_RUN_STATUS_IDLE",
              lastModifiedTime: "2026-11-20T01:55:00.000Z",
            },
          ],
        },
      },
      {
        id: "conv-no-child",
        summary: {
          summary: "単独チャットB",
          stepCount: 5,
          status: "CASCADE_RUN_STATUS_IDLE",
          lastModifiedTime: "2026-11-20T01:50:00.000Z",
          createdTime: "2026-11-20T01:00:00.000Z",
          trajectoryId: "t-b",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
        },
      },
    ];

    render(
      <Sidebar
        conversations={conversations}
        activeId="conv-no-child"
        onSelect={onSelect}
        onNew={vi.fn()}
        onDelete={vi.fn()}
        onSettings={vi.fn()}
        loading={false}
        connected={true}
        isOpen={true}
        onToggle={vi.fn()}
      />,
    );

    // Idle child subagent is collapsed by default so the sidebar stays uncluttered
    expect(screen.queryByText("画面チェッカー")).not.toBeInTheDocument();

    // Filter to subagent-bearing chats only
    const filterWrap = screen.getByTestId("sidebar-subagent-filter");
    const filterBtn = filterWrap.querySelector("button")!;
    fireEvent.click(filterBtn);
    expect(screen.getByText("親チャットA")).toBeInTheDocument();
    expect(screen.queryByText("単独チャットB")).not.toBeInTheDocument();

    // Expand agent tree on demand, then click child subagent
    fireEvent.click(screen.getByText(/エージェント \(1件\)/));
    expect(screen.getByText("画面チェッカー")).toBeInTheDocument();
    expect(screen.getByText("browser")).toBeInTheDocument();
    fireEvent.click(screen.getByText("画面チェッカー"));
    expect(onSelect).toHaveBeenCalledWith("child-idle-1");
  });

  it("renders unified Japanese Projects groups with chats directly inside and empty CLI Project without NaN dates", async () => {
    const { api } = await import("../api/client");
    vi.mocked(api.projects).mockResolvedValueOnce({
      projects: [
        { id: "proj-ai", name: "AI", folderPath: "/Users/demo/AI", folderUri: "file:///Users/demo/AI" },
        { id: "proj-cli", name: "CLI Project", isDefaultCli: true },
      ],
    });
    const onNewInProject = vi.fn();
    const conversations: ConversationEntry[] = [
      {
        id: "conv-ai-1",
        summary: {
          summary: "AI配下の実チャット",
          stepCount: 12,
          status: "CASCADE_RUN_STATUS_IDLE",
          lastModifiedTime: "",
          createdTime: "",
          trajectoryId: "t-ai-1",
          assignedProjectId: "proj-ai",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/AI" }],
        },
      },
      {
        id: "conv-recent-unassigned",
        summary: {
          summary: "未分類の通常チャット",
          stepCount: 4,
          status: "CASCADE_RUN_STATUS_IDLE",
          lastModifiedTime: "2026-11-21T01:00:00.000Z",
          createdTime: "2026-11-21T00:30:00.000Z",
          trajectoryId: "t-recent-1",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/AI" }],
        },
      },
    ];

    render(
      <Sidebar
        conversations={conversations}
        activeId={null}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onNewInProject={onNewInProject}
        onDelete={vi.fn()}
        onSettings={vi.fn()}
        loading={false}
        connected={true}
        isOpen={true}
        onToggle={vi.fn()}
      />,
    );

    expect(await screen.findByTestId("sidebar-projects")).toBeInTheDocument();
    expect(screen.getByText("プロジェクト")).toBeInTheDocument();
    // AI appears once as a unified project folder containing its conversation directly
    expect(screen.getAllByText("AI")).toHaveLength(1);
    expect(screen.getByText("AI配下の実チャット")).toBeInTheDocument();
    expect(screen.getByText("💬 最近のチャット")).toBeInTheDocument();
    expect(screen.getByText("未分類の通常チャット")).toBeInTheDocument();
    expect(screen.queryByText(/NaN日前/)).not.toBeInTheDocument();
    expect(screen.getByText("CLI Project")).toBeInTheDocument();
    expect(screen.getByText("まだ会話はありません")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("CLI Projectで新規チャット"));
    expect(onNewInProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: "proj-cli", name: "CLI Project" }),
    );
  });

  it("sorts pinned running chats above unpinned running chats and supports 1-click unpin", async () => {
    const { api } = await import("../api/client");
    vi.mocked(api.updateAnnotations).mockResolvedValueOnce({
      ok: true,
      id: "run-pinned",
      pinned: false,
    });

    const conversations: ConversationEntry[] = [
      {
        id: "run-normal",
        summary: {
          summary: "通常実行チャット",
          stepCount: 20,
          status: "CASCADE_RUN_STATUS_RUNNING",
          lastModifiedTime: "2026-11-20T07:10:00.000Z",
          createdTime: "2026-11-20T07:00:00.000Z",
          trajectoryId: "t-norm",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
        },
      },
      {
        id: "run-pinned",
        summary: {
          summary: "ピン留め実行チャット",
          stepCount: 15,
          status: "CASCADE_RUN_STATUS_RUNNING",
          lastModifiedTime: "2026-11-20T07:05:00.000Z",
          createdTime: "2026-11-20T07:00:00.000Z",
          trajectoryId: "t-pin",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
          annotations: { pinned: true },
        },
      },
    ];

    const { container } = render(
      <Sidebar
        conversations={conversations}
        activeId="run-pinned"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onDelete={vi.fn()}
        onSettings={vi.fn()}
        loading={false}
        connected={true}
        isOpen={true}
        onToggle={vi.fn()}
      />,
    );

    const titles = Array.from(
      container.querySelectorAll(".running-workspace-group .sidebar-item-title"),
    ).map((el) => el.textContent);
    expect(titles[0]).toContain("ピン留め実行チャット");
    expect(titles[1]).toContain("通常実行チャット");

    const unpinBtn = screen.getByRole("button", { name: "ピン留めを解除" });
    fireEvent.click(unpinBtn);
    expect(api.updateAnnotations).toHaveBeenCalledWith("run-pinned", {
      pinned: false,
    });
  });

  it("renders active background tasks in the per-chat agent tree and exposes 🌿 枝分かれ in the chat context menu", () => {
    const onBranchSideChat = vi.fn();
    const onOpenAgentPanel = vi.fn();
    const conversations: ConversationEntry[] = [
      {
        id: "conv-agent-tree",
        summary: {
          summary: "統合テスト対象チャット",
          stepCount: 30,
          status: "CASCADE_RUN_STATUS_RUNNING",
          lastModifiedTime: "2026-11-20T08:00:00.000Z",
          createdTime: "2026-11-20T07:00:00.000Z",
          trajectoryId: "t-tree",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
          subagents: [
            {
              id: "sub-1",
              role: "コード調査エージェント",
              typeName: "research",
              status: "CASCADE_RUN_STATUS_IDLE",
              lastModifiedTime: "2026-11-20T07:55:00.000Z",
            },
          ],
          activeTasks: [
            {
              id: "task-777",
              sizeBytes: 1024,
              updatedAt: "2026-11-20T08:00:00.000Z",
              isActive: true,
            },
          ],
          taskCount: 4,
        },
      },
    ];

    render(
      <Sidebar
        conversations={conversations}
        activeId="conv-agent-tree"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onBranchSideChat={onBranchSideChat}
        onOpenAgentPanel={onOpenAgentPanel}
        onDelete={vi.fn()}
        onSettings={vi.fn()}
        loading={false}
        connected={true}
        isOpen={true}
        onToggle={vi.fn()}
      />,
    );

    // Unified agent tree is collapsed by default and opens on click
    expect(screen.getByText(/エージェント稼働中 \(2件\)/)).toBeInTheDocument();
    expect(screen.queryByText("コード調査エージェント")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/エージェント稼働中 \(2件\)/));
    expect(screen.getByText("コード調査エージェント")).toBeInTheDocument();
    expect(screen.getByText("⚙️ task-777")).toBeInTheDocument();

    fireEvent.click(screen.getByText(/タスクログ詳細 \(4件\)/));
    expect(onOpenAgentPanel).toHaveBeenCalledWith("conv-agent-tree");

    // Chat ⋯ menu exposes 🌿 枝分かれ right alongside rename & pin
    fireEvent.click(screen.getByTitle("メニュー"));
    expect(screen.getByText("✏️ 名前を変更")).toBeInTheDocument();
    fireEvent.click(screen.getByText("🌿 枝分かれ"));
    expect(onBranchSideChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conv-agent-tree" }),
    );
  });

  it("allows assigning a chat to a project from context menu and removing a project from project menu", async () => {
    const { api } = await import("../api/client");
    vi.mocked(api.projects).mockResolvedValueOnce({
      projects: [
        { id: "proj-alpha", name: "開発ノート", folderPath: "/tmp/notes" },
      ],
      settings: { defaultProjectFolder: "/tmp/default", createProjectSubfolder: false },
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const conversations: ConversationEntry[] = [
      {
        id: "conv-move",
        summary: {
          summary: "移動したいチャット",
          stepCount: 3,
          status: "CASCADE_RUN_STATUS_IDLE",
          lastModifiedTime: "2026-11-21T03:00:00.000Z",
          createdTime: "2026-11-21T02:00:00.000Z",
          trajectoryId: "t-move",
          workspaces: [],
        },
      },
    ];

    render(
      <Sidebar
        conversations={conversations}
        activeId={null}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onDelete={vi.fn()}
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        loading={false}
        connected={true}
        isOpen={true}
        onToggle={vi.fn()}
      />,
    );

    expect(await screen.findByText("開発ノート")).toBeInTheDocument();

    // Open chat menu -> プロジェクトに追加・移動 -> select 開発ノート
    fireEvent.click(screen.getByTitle("メニュー"));
    fireEvent.click(screen.getByText("📁 プロジェクトに追加・移動"));
    const moveTargets = screen.getAllByRole("button", { name: /開発ノート/ });
    fireEvent.click(moveTargets[moveTargets.length - 1]);
    expect(api.assignConversationProject).toHaveBeenCalledWith(
      "conv-move",
      "proj-alpha",
    );

    // Open project menu -> 🗑️ プロジェクトを除去
    fireEvent.click(screen.getByLabelText("開発ノートのメニュー"));
    fireEvent.click(screen.getByText("🗑️ プロジェクトを除去"));
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.deleteProject).toHaveBeenCalledWith("proj-alpha");

    confirmSpy.mockRestore();
  });

  it("renders pinned or running project chats only once in the sidebar without duplicating under the project group", async () => {
    const { api } = await import("../api/client");
    vi.mocked(api.projects).mockResolvedValueOnce({
      projects: [
        {
          id: "proj-dev",
          name: "アプリ開発",
          folderUri: "file:///workspace/app",
          folderPath: "/workspace/app",
        },
      ],
    });

    const conversations: ConversationEntry[] = [
      {
        id: "conv-pinned-in-proj",
        summary: {
          summary: "ピン留め済みプロジェクトチャット",
          stepCount: 12,
          status: "CASCADE_RUN_STATUS_IDLE",
          lastModifiedTime: "2026-11-21T02:00:00.000Z",
          createdTime: "2026-11-21T01:00:00.000Z",
          trajectoryId: "t-pin-proj",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///workspace/app" }],
          annotations: { pinned: true },
        },
      },
      {
        id: "conv-running-in-proj",
        summary: {
          summary: "実行中プロジェクトチャット",
          stepCount: 5,
          status: "CASCADE_RUN_STATUS_RUNNING",
          lastModifiedTime: "2026-11-21T02:05:00.000Z",
          createdTime: "2026-11-21T01:30:00.000Z",
          trajectoryId: "t-run-proj",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///workspace/app" }],
        },
      },
      {
        id: "conv-normal-in-proj",
        summary: {
          summary: "通常プロジェクトチャット",
          stepCount: 3,
          status: "CASCADE_RUN_STATUS_IDLE",
          lastModifiedTime: "2026-11-21T01:40:00.000Z",
          createdTime: "2026-11-21T01:20:00.000Z",
          trajectoryId: "t-norm-proj",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///workspace/app" }],
        },
      },
    ];

    const { rerender } = render(
      <Sidebar
        conversations={conversations}
        activeId="conv-pinned-in-proj"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onDelete={vi.fn()}
        onSettings={vi.fn()}
        loading={false}
        connected={true}
        isOpen={true}
        onToggle={vi.fn()}
      />,
    );

    expect(await screen.findByText("アプリ開発")).toBeInTheDocument();
    expect(screen.getAllByText("ピン留め済みプロジェクトチャット")).toHaveLength(1);
    expect(screen.getAllByText("実行中プロジェクトチャット")).toHaveLength(1);
    expect(screen.getAllByText("通常プロジェクトチャット")).toHaveLength(1);

    // Order must follow standard AI app layout: 実行中 -> プロジェクト -> ピン留め
    const runningSection = screen.getByText("⚡ 実行中");
    const projectsSection = screen.getByTestId("sidebar-projects");
    const projectItem = screen.getByText("アプリ開発");
    const pinnedSection = screen.getByText("📌 ピン留め");
    expect(
      runningSection.compareDocumentPosition(projectsSection) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      projectsSection.compareDocumentPosition(projectItem) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      projectItem.compareDocumentPosition(pinnedSection) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // When the running chat finishes (IDLE), ⚡ 実行中 disappears and it returns under its original project
    const finishedConversations: ConversationEntry[] = conversations.map((c) =>
      c.id === "conv-running-in-proj"
        ? {
            ...c,
            summary: {
              ...c.summary,
              assignedProjectId: "proj-dev",
              status: "CASCADE_RUN_STATUS_IDLE",
            },
          }
        : c,
    );
    rerender(
      <Sidebar
        conversations={finishedConversations}
        activeId="conv-pinned-in-proj"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onDelete={vi.fn()}
        onSettings={vi.fn()}
        loading={false}
        connected={true}
        isOpen={true}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.queryByText("⚡ 実行中")).not.toBeInTheDocument();
    const returnedChat = screen.getByText("実行中プロジェクトチャット");
    const projectGroupEl = screen.getByText("アプリ開発").closest('[data-project-id="proj-dev"]');
    expect(projectGroupEl).not.toBeNull();
    expect(projectGroupEl?.contains(returnedChat)).toBe(true);
  });
});
