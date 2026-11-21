import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../components/ChatPanel";
import { useStepsStream } from "../hooks/useStepsStream";
import type { TrajectoryStep } from "../types";

vi.mock("../hooks/useStepsStream", () => ({
  useStepsStream: vi.fn(),
}));

vi.mock("../hooks/useChatNotifications", () => ({
  useChatNotifications: vi.fn(),
}));

const mockUseStepsStream = vi.mocked(useStepsStream);

function mockSteps(steps: TrajectoryStep[], wsRunning = false, baseOffset = 0) {
  mockUseStepsStream.mockReturnValue({
    steps,
    baseOffset,
    loading: false,
    error: null,
    hasMore: baseOffset > 0,
    loadingOlder: false,
    wsRunning,
    loadOlder: vi.fn().mockResolvedValue(0),
    refresh: vi.fn(),
    hardRefresh: vi.fn(),
  });
}

describe("ChatPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a web permission and forwards the response from the chat", async () => {
    const onCommandAction = vi.fn().mockResolvedValue(undefined);
    mockSteps([{
      type: "CORTEX_STEP_TYPE_READ_URL",
      status: "CORTEX_STEP_STATUS_WAITING",
      metadata: { sourceTrajectoryStepInfo: { trajectoryId: "traj-web", stepIndex: 41 } },
      requestedInteraction: {
        permission: { resource: { action: "read_url", target: "example.com" } },
      },
    }], true);

    render(<ChatPanel cascadeId="cascade-1" onRevert={vi.fn()} onFilePermission={vi.fn()} onCommandAction={onCommandAction} />);

    expect(screen.getByText("example.com")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "拒否" }));
    expect(onCommandAction).toHaveBeenCalledWith("traj-web", 41, false);
  });

  it("allows a second permission requested by the same tool step", async () => {
    const onCommandAction = vi.fn().mockResolvedValue(undefined);
    const step: TrajectoryStep = {
      type: "CORTEX_STEP_TYPE_GENERIC",
      status: "CORTEX_STEP_STATUS_WAITING",
      metadata: { sourceTrajectoryStepInfo: { trajectoryId: "traj-web", stepIndex: 41 } },
      requestedInteraction: {
        permission: { resource: { action: "read_url", target: "example.com" } },
      },
    };
    const props = {
      cascadeId: "cascade-1", onRevert: vi.fn(),
      onFilePermission: vi.fn(), onCommandAction,
    };
    mockSteps([step], true);
    const { rerender } = render(<ChatPanel {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "許可" }));

    mockSteps([{
      ...step,
      requestedInteraction: {
        permission: { resource: { action: "read_url", target: "example.org" } },
      },
    }], true);
    rerender(<ChatPanel {...props} />);

    expect(screen.getByText("example.org")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "拒否" }));
    expect(onCommandAction).toHaveBeenNthCalledWith(2, "traj-web", 41, false);
  });

  it("renders planner thinking as an implementation plan / thinking panel", () => {
    mockSteps([
      {
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        plannerResponse: {
          modifiedResponse: "I will make the change.",
          thinking: "Inspect the current chat UI, then expose the plan.",
          thinkingDuration: "3.4s",
        },
      },
    ]);

    render(
      <ChatPanel
        cascadeId="cascade-1"
        onRevert={vi.fn()}
        onFilePermission={vi.fn()}
      />,
    );

    expect(screen.getByText("思考プロセス")).toBeInTheDocument();
    expect(screen.getByText("3.4s")).toBeInTheDocument();
    expect(
      screen.getByText("Inspect the current chat UI, then expose the plan."),
    ).toBeInTheDocument();
  });

  it("shows the latest plan as a live panel while the run is active", () => {
    mockSteps(
      [
        {
          type: "CORTEX_STEP_TYPE_USER_INPUT",
          userInput: { items: [{ text: "Please implement this" }] },
        },
        {
          type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
          plannerResponse: {
            thinking: "Inspect first, then patch the UI.",
            thinkingDuration: "1.2s",
          },
        },
      ],
      true,
    );

    render(
      <ChatPanel
        cascadeId="cascade-1"
        onRevert={vi.fn()}
        onFilePermission={vi.fn()}
      />,
    );

    expect(screen.getByText("思考中...")).toBeInTheDocument();
    expect(screen.getByText("1.2s")).toBeInTheDocument();
    expect(
      document.querySelector(".pinned-implementation-plan-message"),
    ).toBeInTheDocument();
  });

  it("cleans up the live plan and keeps thinking within the assistant message after the run ends", () => {
    const steps: TrajectoryStep[] = [
      {
        type: "CORTEX_STEP_TYPE_USER_INPUT",
        userInput: { items: [{ text: "Please implement this" }] },
      },
      {
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        plannerResponse: {
          thinking: "Inspect first, then patch the UI.",
          thinkingDuration: "1.2s",
        },
      },
    ];
    const completedSteps: TrajectoryStep[] = [
      ...steps,
      {
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        plannerResponse: {
          modifiedResponse: "Final answer.",
        },
      },
    ];
    const props = {
      cascadeId: "cascade-1",
      onRevert: vi.fn(),
      onFilePermission: vi.fn(),
    };

    mockSteps(steps, true);
    const { rerender } = render(<ChatPanel {...props} />);
    expect(screen.getByText("思考中...")).toBeInTheDocument();

    mockSteps(completedSteps, false);
    rerender(<ChatPanel {...props} />);

    expect(
      screen.queryByText("思考中..."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("思考プロセス")).toBeInTheDocument();
    const planElement = document.querySelector(
      ".pinned-implementation-plan-message",
    );
    expect(planElement).not.toBeInTheDocument();
    expect(screen.getByText("Final answer.")).toBeInTheDocument();
  });

  it("renders thinking-only turns as a compact 1-line collapsible row without bulky chat-block card", () => {
    mockSteps([
      {
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        plannerResponse: {
          thinking: "Check server logs first.\nThen patch the timeout.",
          thinkingDuration: "2.1s",
        },
      },
    ]);

    const { container } = render(
      <ChatPanel
        cascadeId="cascade-compact"
        onRevert={vi.fn()}
        onFilePermission={vi.fn()}
      />,
    );

    const thinkingMsg = container.querySelector(".thinking-only-message");
    expect(thinkingMsg).toBeInTheDocument();
    expect(thinkingMsg?.querySelector(".chat-block")).toBeNull();
    expect(thinkingMsg?.querySelector(".thinking-only-body")).toBeInTheDocument();
    expect(screen.getByText("思考プロセス")).toBeInTheDocument();
    expect(screen.getByText("2.1s")).toBeInTheDocument();
    expect(screen.getByText(/Check server logs first\./)).toBeInTheDocument();
  });

  it("renders user messages inside a framed chat-block while keeping assistant replies frameless", () => {
    mockSteps([
      {
        type: "CORTEX_STEP_TYPE_USER_INPUT",
        userInput: { items: [{ text: "俺のメッセージだよ" }] },
      },
      {
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        plannerResponse: {
          modifiedResponse: "ギアからの返答本文だよ。",
        },
      },
    ]);

    const { container } = render(
      <ChatPanel
        cascadeId="cascade-framing"
        onRevert={vi.fn()}
        onFilePermission={vi.fn()}
      />,
    );

    const userBody = container.querySelector(".message.user .message-body");
    const assistantBody = container.querySelector(
      ".message.assistant .message-body",
    );
    expect(userBody).toBeInTheDocument();
    expect(userBody?.classList.contains("chat-block")).toBe(true);
    expect(assistantBody).toBeInTheDocument();
    expect(assistantBody?.classList.contains("chat-block")).toBe(false);
  });

  it("collapses contiguous work steps into a single closed details group by default while keeping waiting approvals visible", async () => {
    const onCommandAction = vi.fn().mockResolvedValue(undefined);
    mockSteps([
      {
        type: "CORTEX_STEP_TYPE_USER_INPUT",
        userInput: { items: [{ text: "調べて直して" }] },
      },
      {
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        plannerResponse: {
          thinking: "まずファイルを読む。",
          thinkingDuration: "0.8s",
        },
      },
      {
        type: "CORTEX_STEP_TYPE_VIEW_FILE",
        status: "CORTEX_STEP_STATUS_DONE",
        viewFile: { absolutePathUri: "file:///tmp/app.ts" },
      },
      {
        type: "CORTEX_STEP_TYPE_RUN_COMMAND",
        status: "CORTEX_STEP_STATUS_DONE",
        runCommand: { commandLine: "pnpm test" },
      },
      {
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        plannerResponse: {
          modifiedResponse: "修正が完了しました。",
        },
      },
      {
        type: "CORTEX_STEP_TYPE_READ_URL",
        status: "CORTEX_STEP_STATUS_WAITING",
        metadata: {
          sourceTrajectoryStepInfo: { trajectoryId: "traj-wait", stepIndex: 5 },
        },
        requestedInteraction: {
          permission: { resource: { action: "read_url", target: "docs.example" } },
        },
      },
    ]);

    const { container } = render(
      <ChatPanel
        cascadeId="cascade-work-group"
        onRevert={vi.fn()}
        onFilePermission={vi.fn()}
        onCommandAction={onCommandAction}
      />,
    );

    const group = screen.getByTestId("work-steps-group");
    const details = group.querySelector("details") as HTMLDetailsElement;
    expect(details).toBeInTheDocument();
    expect(details.open).toBe(false);
    expect(screen.getByText("作業内容 (3件)")).toBeInTheDocument();

    // Waiting permission step must remain directly outside the collapsed group
    expect(group.textContent).not.toContain("docs.example");
    expect(screen.getByText("docs.example")).toBeInTheDocument();

    // Clicking the summary opens the collapsed work details
    await userEvent.click(screen.getByText("作業内容 (3件)"));
    expect(details.open).toBe(true);
    expect(container.querySelector(".message.assistant .message-body")).toHaveTextContent(
      "修正が完了しました。",
    );
  });

  it("renders LS ERROR_MESSAGE steps visibly outside work collapse and supports revert + comment removal with absolute stepOffset", async () => {
    const onRevert = vi.fn();
    const onRemoveComment = vi.fn();
    const onRemoveOptimistic = vi.fn();
    mockSteps(
      [
        {
          type: "CORTEX_STEP_TYPE_USER_INPUT",
          userInput: { items: [{ text: "おーい" }] },
        },
        {
          type: "CORTEX_STEP_TYPE_ERROR_MESSAGE",
          errorMessage: {
            error: { shortError: "Agent execution terminated due to error." },
          },
        },
      ],
      false,
      140,
    );

    render(
      <ChatPanel
        cascadeId="cascade-revert-remove"
        onRevert={onRevert}
        onRemoveComment={onRemoveComment}
        onRemoveOptimistic={onRemoveOptimistic}
        onFilePermission={vi.fn()}
        optimisticMessages={[
          {
            role: "user",
            content: "送信失敗コメント",
            stepIndex: -1,
            type: "CORTEX_STEP_TYPE_USER_INPUT",
            optimisticId: "opt-failed-1",
            optimisticState: "failed",
          },
        ]}
      />,
    );

    // Server error must be directly visible and NOT hidden in a work group
    expect(
      screen.getByText(/Agent execution terminated due to error\./),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("work-steps-group")).not.toBeInTheDocument();

    // Committed user comment uses absolute offset 140 on revert and 2-click delete
    const revertBtns = screen.getAllByRole("button", { name: "戻す" });
    await userEvent.click(revertBtns[0]);
    expect(onRevert).toHaveBeenCalledWith(140, "おーい");

    const deleteBtns = screen.getAllByRole("button", { name: "削除" });
    await userEvent.click(deleteBtns[0]);
    expect(onRemoveComment).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "削除する？" }));
    expect(onRemoveComment).toHaveBeenCalledWith(140);

    // Failed local comment restores to draft on 戻す and removes immediately on 削除
    await userEvent.click(revertBtns[1]);
    expect(onRemoveOptimistic).toHaveBeenCalledWith(
      "opt-failed-1",
      "送信失敗コメント",
    );
    await userEvent.click(screen.getAllByRole("button", { name: "削除" })[1]);
    expect(onRemoveOptimistic).toHaveBeenCalledWith("opt-failed-1");
  });

  it("collapses long user messages by default and toggles expand/collapse", async () => {
    const longLines = Array.from(
      { length: 14 },
      (_, i) => `長い引き継ぎ本文の行 ${i + 1}`,
    ).join("\n");

    mockSteps(
      [
        {
          type: "CORTEX_STEP_TYPE_USER_INPUT",
          userInput: { items: [{ text: longLines }] },
        },
      ],
      false,
      0,
    );

    render(
      <ChatPanel
        cascadeId="cascade-long-collapse"
        onRevert={vi.fn()}
        onFilePermission={vi.fn()}
      />,
    );

    const toggleBtn = screen.getByTestId("msg-long-toggle-btn");
    expect(toggleBtn).toHaveTextContent("▼ 全文を表示");
    await userEvent.click(toggleBtn);
    expect(toggleBtn).toHaveTextContent("▲ 折りたたむ");
    await userEvent.click(toggleBtn);
    expect(toggleBtn).toHaveTextContent("▼ 全文を表示");
  });

  it("shows floating scroll-to-bottom arrow when scrolled up and jumps to bottom on click", () => {
    mockSteps(
      [
        {
          type: "CORTEX_STEP_TYPE_USER_INPUT",
          userInput: { items: [{ text: "上のメッセージ" }] },
        },
        {
          type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
          plannerResponse: { modifiedResponse: "最新の返答" },
        },
      ],
      false,
      0,
    );

    const { container } = render(
      <ChatPanel
        cascadeId="cascade-scroll-arrow"
        onRevert={vi.fn()}
        onFilePermission={vi.fn()}
      />,
    );

    const chatArea = container.querySelector(".chat-area") as HTMLDivElement;
    expect(chatArea).toBeTruthy();
    expect(screen.queryByTestId("scroll-to-bottom-btn")).not.toBeInTheDocument();

    const scrollToSpy = vi.fn();
    Object.defineProperty(chatArea, "scrollHeight", { value: 2400, configurable: true });
    Object.defineProperty(chatArea, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(chatArea, "scrollTop", { value: 100, writable: true, configurable: true });
    chatArea.scrollTo = scrollToSpy;

    fireEvent.scroll(chatArea);

    const btn = screen.getByTestId("scroll-to-bottom-btn");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-label", "一番下へスクロール");

    fireEvent.click(btn);
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 2400, behavior: "smooth" });
    expect(screen.queryByTestId("scroll-to-bottom-btn")).not.toBeInTheDocument();
  });
});
