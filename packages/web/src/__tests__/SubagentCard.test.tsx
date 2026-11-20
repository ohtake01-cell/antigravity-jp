import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SubagentCard } from "../components/StepCards";
import type { TrajectoryStep } from "../types";

function nativeStep(
  status = "CORTEX_STEP_STATUS_DONE",
): TrajectoryStep {
  return {
    type: "CORTEX_STEP_TYPE_INVOKE_SUBAGENT",
    status,
    invokeSubagent: {
      subagents: [
        {
          role: "Integration Reviewer",
          typeName: "general-purpose",
          initialPrompt: "Review the integration",
        },
        {
          role: "Security Reviewer",
          typeName: "research",
          initialPrompt: "Review security boundaries",
        },
      ],
    },
  };
}

describe("SubagentCard", () => {
  it("renders every native subagent and expands every prompt", async () => {
    render(<SubagentCard step={nativeStep()} />);

    expect(screen.getByText("Integration Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Security Reviewer")).toBeInTheDocument();
    expect(screen.queryByText("Review the integration")).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /2件のサブエージェントを起動/i }),
    );

    expect(screen.getByText("Review the integration")).toBeInTheDocument();
    expect(screen.getByText("Review security boundaries")).toBeInTheDocument();
  });

  it.each([
    ["CORTEX_STEP_STATUS_PENDING", "準備中", "cmd-wait"],
    ["CORTEX_STEP_STATUS_ERROR", "エラー", "cmd-fail"],
    ["CORTEX_STEP_STATUS_CANCELED", "キャンセル", "cmd-fail"],
    ["CORTEX_STEP_STATUS_INTERRUPTED", "中断", "cmd-fail"],
    ["CORTEX_STEP_STATUS_DONE", "完了", "cmd-ok"],
  ])("renders %s with the correct state", (status, label, className) => {
    const { container } = render(<SubagentCard step={nativeStep(status)} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector(".subagent-card")).toHaveClass(className);
  });

  it("renders tool-specific send_message content", async () => {
    const step: TrajectoryStep = {
      type: "CORTEX_STEP_TYPE_TOOL_CALL",
      metadata: {
        toolCall: {
          name: "send_message",
          argumentsJson: JSON.stringify({
            Recipient: "conversation-123",
            Message: "Please inspect the auth flow",
          }),
        },
      },
    };
    render(<SubagentCard step={step} />);

    expect(screen.getByText("conversation-123 へメッセージ送信")).toBeInTheDocument();
    expect(screen.getByText("conversation-123")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /conversation-123 へメッセージ送信/i }),
    );
    expect(screen.getByText("Please inspect the auth flow")).toBeInTheDocument();
  });

  it("renders untrusted labels as text rather than HTML", () => {
    const step: TrajectoryStep = {
      type: "CORTEX_STEP_TYPE_INVOKE_SUBAGENT",
      invokeSubagent: {
        subagents: [
          {
            role: '<img src=x onerror="alert(1)">',
            initialPrompt: "safe text",
          },
        ],
      },
    };
    const { container } = render(<SubagentCard step={step} />);

    expect(
      screen.getByText('<img src=x onerror="alert(1)">'),
    ).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("resolves child conversation link from parent childSubagents fallback when step omits results", async () => {
    const onOpen = vi.fn();
    render(
      <SubagentCard
        step={nativeStep()}
        onOpenConversation={onOpen}
        childSubagents={[
          {
            id: "sub-conv-integration",
            role: "Integration Reviewer",
            typeName: "general-purpose",
            status: "CASCADE_RUN_STATUS_IDLE",
            lastModifiedTime: "2026-11-20T02:00:00.000Z",
          },
        ]}
      />,
    );

    const openBtn = screen.getByRole("button", { name: "子チャットを開く →" });
    await userEvent.click(openBtn);
    expect(onOpen).toHaveBeenCalledWith("sub-conv-integration");
  });
});
