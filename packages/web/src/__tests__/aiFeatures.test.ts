import { describe, it, expect, beforeEach } from "vitest";
import {
  BUILTIN_PROMPT_TEMPLATES,
  filterPromptTemplates,
  getAllPromptTemplates,
  saveCustomPromptTemplates,
} from "../utils/promptTemplates";
import { formatConversationAsMarkdown } from "../utils/exportConversation";
import { getAskQuestionRequest } from "../utils/stepCards";
import { stepsToMessages } from "../transforms/stepsToMessages";
import type { TrajectoryStep } from "../types";

describe("AI app convenience features & fallback safety net", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("filters builtin and custom slash prompt templates", () => {
    expect(BUILTIN_PROMPT_TEMPLATES.length).toBeGreaterThanOrEqual(5);
    saveCustomPromptTemplates([
      {
        id: "custom-1",
        command: "/日報",
        label: "日報テンプレ",
        description: "今日の成果をまとめる",
        template: "今日やったことを日報形式でまとめて：\n\n",
      },
    ]);
    const all = getAllPromptTemplates();
    const matched = filterPromptTemplates("/日", all);
    expect(matched.some((t) => t.command === "/日報")).toBe(true);
    const summaryMatched = filterPromptTemplates("/要約", all);
    expect(summaryMatched[0]?.command).toBe("/要約");
  });

  it("formats user and assistant messages cleanly into Markdown", () => {
    const md = formatConversationAsMarkdown("設計レビュー", [
      { role: "user", content: "この構成を見てください", stepIndex: 0, type: "CORTEX_STEP_TYPE_USER_INPUT" },
      { role: "system", content: "ignored tool step", stepIndex: 1, type: "CORTEX_STEP_TYPE_GENERIC" },
      { role: "assistant", content: "とても良い設計です。", stepIndex: 2, type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE" },
    ]);
    expect(md).toContain("# 設計レビュー");
    expect(md).toContain("## ユーザー");
    expect(md).toContain("この構成を見てください");
    expect(md).toContain("## AI");
    expect(md).toContain("とても良い設計です。");
    expect(md).not.toContain("ignored tool step");
  });

  it("recovers ask_question cards from toolCall.argumentsJson fallback when direct field is empty", () => {
    const step: TrajectoryStep = {
      type: "CORTEX_STEP_TYPE_ASK_QUESTION",
      status: "CORTEX_STEP_STATUS_WAITING",
      metadata: {
        toolCall: {
          id: "call-1",
          name: "ask_question",
          argumentsJson: JSON.stringify({
            questions: [
              {
                question: "どの機能を入れますか？",
                is_multi_select: true,
                options: ["オプションA", "オプションB"],
              },
            ],
          }),
        },
      },
    };

    const req = getAskQuestionRequest(step);
    expect(req?.questions).toHaveLength(1);
    expect(req?.questions?.[0]?.isMultiSelect).toBe(true);
    expect(req?.questions?.[0]?.options?.[0]?.text).toBe("オプションA");

    const msgs = stepsToMessages([step], 0);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe("CORTEX_STEP_TYPE_ASK_QUESTION");
  });

  it("renders a generic waiting safety-net card for unknown future WAITING steps", () => {
    const futureStep: TrajectoryStep = {
      type: "CORTEX_STEP_TYPE_FUTURE_INTERACTIVE_WIDGET",
      status: "CORTEX_STEP_STATUS_WAITING",
      metadata: {
        toolCall: {
          id: "call-future",
          name: "future_approval_dialog",
        },
      },
    };

    const msgs = stepsToMessages([futureStep], 0);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe("CORTEX_STEP_TYPE_GENERIC_WAITING");
    expect(msgs[0].content).toContain("future_approval_dialog");
  });
});
