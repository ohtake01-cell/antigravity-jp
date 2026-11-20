import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { AskQuestionCard, CommandCard } from "../components/StepCards";
import type { AskQuestionRequest, TrajectoryStep } from "../types";

/** Helper: build a WAITING run-command step */
function waitingStep(overrides: Partial<TrajectoryStep> = {}): TrajectoryStep {
  return {
    type: "CORTEX_STEP_TYPE_RUN_COMMAND",
    status: "CORTEX_STEP_STATUS_WAITING",
    metadata: {
      sourceTrajectoryStepInfo: {
        trajectoryId: "traj-1",
        stepIndex: 7,
      },
    },
    runCommand: {
      proposedCommandLine: "npm install",
      cwd: "/app",
    },
    ...overrides,
  };
}

describe("CommandCard", () => {
  it("shows approve/reject buttons when step is WAITING", () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <CommandCard step={waitingStep()} onCommandAction={onAction} />,
    );

    expect(screen.getByText("承認")).toBeInTheDocument();
    expect(screen.getByText("却下")).toBeInTheDocument();
    expect(screen.getByText("承認待ち")).toBeInTheDocument();
  });

  it("does not show buttons when step is not WAITING", () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const step: TrajectoryStep = {
      type: "CORTEX_STEP_TYPE_RUN_COMMAND",
      status: "CORTEX_STEP_STATUS_DONE",
      runCommand: { commandLine: "ls", exitCode: 0 },
    };
    render(<CommandCard step={step} onCommandAction={onAction} />);

    expect(screen.queryByText("承認")).not.toBeInTheDocument();
    expect(screen.queryByText("却下")).not.toBeInTheDocument();
  });

  it("does not show buttons without onCommandAction callback", () => {
    render(<CommandCard step={waitingStep()} />);

    expect(screen.queryByText("承認")).not.toBeInTheDocument();
  });

  it("hides buttons after successful approval", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <CommandCard step={waitingStep()} onCommandAction={onAction} />,
    );

    await userEvent.click(screen.getByText("承認"));

    expect(onAction).toHaveBeenCalledWith("traj-1", 7, true);
    expect(screen.queryByText("承認")).not.toBeInTheDocument();
  });

  it("restores buttons after failed approval (retry path)", async () => {
    const onAction = vi.fn().mockRejectedValue(new Error("network error"));
    render(
      <CommandCard step={waitingStep()} onCommandAction={onAction} />,
    );

    await userEvent.click(screen.getByText("承認"));

    // Buttons must reappear so the user can retry
    expect(screen.getByText("承認")).toBeInTheDocument();
    expect(screen.getByText("却下")).toBeInTheDocument();
  });

  it("restores buttons after failed rejection (retry path)", async () => {
    const onAction = vi.fn().mockRejectedValue(new Error("timeout"));
    render(
      <CommandCard step={waitingStep()} onCommandAction={onAction} />,
    );

    await userEvent.click(screen.getByText("却下"));

    expect(onAction).toHaveBeenCalledWith("traj-1", 7, false);
    expect(screen.getByText("承認")).toBeInTheDocument();
    expect(screen.getByText("却下")).toBeInTheDocument();
  });

  it("shows proposedCommandLine when waiting", () => {
    render(<CommandCard step={waitingStep()} />);

    expect(screen.getByText("npm install")).toBeInTheDocument();
  });

  it("shows commandLine (not proposedCommandLine) when not waiting", () => {
    const step: TrajectoryStep = {
      type: "CORTEX_STEP_TYPE_RUN_COMMAND",
      status: "CORTEX_STEP_STATUS_DONE",
      runCommand: {
        commandLine: "npm test",
        proposedCommandLine: "npm install",
        exitCode: 0,
      },
    };
    render(<CommandCard step={step} />);

    expect(screen.getByText("npm test")).toBeInTheDocument();
  });
});

function askQuestionStep(): TrajectoryStep {
  return {
    type: "CORTEX_STEP_TYPE_ASK_QUESTION",
    status: "CORTEX_STEP_STATUS_WAITING",
    metadata: {
      sourceTrajectoryStepInfo: {
        trajectoryId: "traj-1",
        stepIndex: 9,
      },
    },
  };
}

function askQuestionRequest(): AskQuestionRequest {
  return {
    questions: [
      {
        question: "Pick one",
        options: [
          { id: "a", text: "Alpha" },
          { id: "b", text: "Beta" },
        ],
      },
    ],
  };
}

describe("AskQuestionCard", () => {
  it("submits the selected option", async () => {
    const onAskQuestion = vi.fn().mockResolvedValue(undefined);
    render(
      <AskQuestionCard
        step={askQuestionStep()}
        askQuestionRequest={askQuestionRequest()}
        fallbackStepIndex={3}
        onAskQuestion={onAskQuestion}
      />,
    );

    await userEvent.click(screen.getByText("Beta"));
    await userEvent.click(screen.getByText("送信"));

    expect(onAskQuestion).toHaveBeenCalledWith("traj-1", 9, [
      expect.objectContaining({
        question: "Pick one",
        selectedOptionIds: ["b"],
      }),
    ]);
  });

  it("marks questions skipped when skipping", async () => {
    const onAskQuestion = vi.fn().mockResolvedValue(undefined);
    render(
      <AskQuestionCard
        step={askQuestionStep()}
        askQuestionRequest={askQuestionRequest()}
        fallbackStepIndex={3}
        onAskQuestion={onAskQuestion}
      />,
    );

    await userEvent.click(screen.getByText("スキップ"));

    expect(onAskQuestion).toHaveBeenCalledWith("traj-1", 9, [
      expect.objectContaining({
        question: "Pick one",
        selectedOptionIds: [],
        skipped: true,
      }),
    ]);
  });
});
