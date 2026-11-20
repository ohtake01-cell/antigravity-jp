import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AgentMonitorPanel } from "../components/AgentMonitorPanel";

vi.mock("../api/client", () => ({
  api: {
    conversationAgents: vi.fn(),
  },
}));

describe("AgentMonitorPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders subagents and expandable background task logs and opens child chats", async () => {
    const { api } = await import("../api/client");
    vi.mocked(api.conversationAgents).mockResolvedValue({
      conversationId: "parent-1",
      subagents: [
        {
          id: "sub-browser-1",
          role: "Porta Live UI Verifier",
          typeName: "browser",
          state: "SUBAGENT_STATE_ALIVE",
          status: "CASCADE_RUN_STATUS_RUNNING",
          running: true,
          stepCount: 42,
          spawnStepIndex: 141,
          lastModifiedTime: new Date().toISOString(),
        },
      ],
      tasks: [
        {
          id: "task-538",
          fileName: "task-538.log",
          sizeBytes: 3072,
          updatedAt: new Date().toISOString(),
          isActive: false,
          tailPreview: "Command exited with code 0\nALL CHECKS PASSED",
        },
      ],
      counts: {
        subagents: 1,
        runningSubagents: 1,
        tasks: 1,
        activeTasks: 0,
      },
    });

    const onOpenConversation = vi.fn();
    render(
      <AgentMonitorPanel
        isOpen={true}
        conversationId="parent-1"
        activeId="parent-1"
        onClose={vi.fn()}
        onOpenConversation={onOpenConversation}
      />,
    );

    expect(await screen.findByText("Porta Live UI Verifier")).toBeInTheDocument();
    expect(screen.getByText("browser")).toBeInTheDocument();
    expect(screen.getByText("42 ステップ")).toBeInTheDocument();
    expect(screen.getByText("task-538")).toBeInTheDocument();

    // Open subagent chat
    fireEvent.click(screen.getByRole("button", { name: "チャットを開く →" }));
    expect(onOpenConversation).toHaveBeenCalledWith("sub-browser-1");

    // Expand background task log
    expect(screen.queryByTestId("agent-monitor-task-log")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /task-538/ }));
    expect(screen.getByTestId("agent-monitor-task-log")).toHaveTextContent(
      "ALL CHECKS PASSED",
    );

    // Filter to tasks only
    fireEvent.click(screen.getByRole("tab", { name: /タスク/ }));
    expect(screen.queryByText("Porta Live UI Verifier")).not.toBeInTheDocument();
    expect(screen.getByText("task-538")).toBeInTheDocument();
  });
});
