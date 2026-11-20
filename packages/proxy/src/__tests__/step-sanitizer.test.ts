import { describe, expect, it } from "vitest";
import { sanitizeStepForClient, sanitizeStepsForClient } from "../step-sanitizer.js";

describe("step-sanitizer", () => {
  it("strips heavy viewFile.mediaData and viewFile.content while preserving display metadata and permissions", () => {
    const rawStep = {
      type: "CORTEX_STEP_TYPE_VIEW_FILE",
      status: "CORTEX_STEP_STATUS_DONE",
      metadata: {
        toolCall: {
          id: "call-1",
          name: "read_file",
          argumentsJson: '{"Path":"/tmp/a.mp4"}',
          thinkingSignature: "A".repeat(4000),
        },
      },
      viewFile: {
        absolutePathUri: "file:///tmp/a.mp4",
        startLine: 1,
        endLine: 50,
        numBytes: 5_000_000,
        content: "Showing binary file...",
        mediaData: {
          mimeType: "video/mp4",
          inlineData: "B".repeat(100_000),
        },
        filePermissionRequest: {
          absolutePathUri: "file:///tmp/a.mp4",
        },
      },
    };

    const cleaned = sanitizeStepForClient(rawStep) as Record<string, any>;

    expect(cleaned.viewFile.absolutePathUri).toBe("file:///tmp/a.mp4");
    expect(cleaned.viewFile.startLine).toBe(1);
    expect(cleaned.viewFile.endLine).toBe(50);
    expect(cleaned.viewFile.filePermissionRequest).toEqual({
      absolutePathUri: "file:///tmp/a.mp4",
    });
    expect(cleaned.viewFile.mediaData).toBeUndefined();
    expect(cleaned.viewFile.content).toBeUndefined();
    expect(cleaned.metadata.toolCall.name).toBe("read_file");
    expect(cleaned.metadata.toolCall.thinkingSignature).toBeUndefined();
    // Original object is not mutated
    expect(rawStep.viewFile.mediaData).toBeDefined();
  });

  it("strips thinkingSignature from plannerResponse.toolCalls while keeping userInput.media untouched", () => {
    const steps = [
      {
        type: "CORTEX_STEP_TYPE_USER_INPUT",
        userInput: {
          items: [{ text: "hello" }],
          media: [{ mimeType: "image/png", inlineData: "BASE64USERIMG" }],
        },
      },
      {
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        plannerResponse: {
          modifiedResponse: "answer",
          thinking: "thought",
          toolCalls: [
            {
              id: "tc-1",
              name: "invoke_subagent",
              argumentsJson: "{}",
              thinkingSignature: "SIG".repeat(500),
            },
          ],
        },
      },
    ];

    const cleaned = sanitizeStepsForClient(steps) as Record<string, any>[];
    expect(cleaned[0].userInput.media).toEqual([
      { mimeType: "image/png", inlineData: "BASE64USERIMG" },
    ]);
    expect(cleaned[1].plannerResponse.modifiedResponse).toBe("answer");
    expect(cleaned[1].plannerResponse.thinking).toBe("thought");
    expect(cleaned[1].plannerResponse.toolCalls[0].name).toBe("invoke_subagent");
    expect(cleaned[1].plannerResponse.toolCalls[0].thinkingSignature).toBeUndefined();
  });

  it("compacts huge unifiedDiff.lines into -U3 hunks while preserving exact INSERT/DELETE counts", () => {
    const lines: Array<{ type: string; text: string }> = [];
    for (let i = 0; i < 1500; i++) {
      lines.push({
        type: "UNIFIED_DIFF_LINE_TYPE_UNCHANGED",
        text: `const unchangedLine${i} = ${i};`,
      });
    }
    lines[200] = { type: "UNIFIED_DIFF_LINE_TYPE_DELETE", text: "oldA()" };
    lines[201] = { type: "UNIFIED_DIFF_LINE_TYPE_INSERT", text: "newA()" };
    lines[1100] = { type: "UNIFIED_DIFF_LINE_TYPE_INSERT", text: "newB()" };
    lines[1101] = { type: "UNIFIED_DIFF_LINE_TYPE_INSERT", text: "newC()" };

    const rawStep = {
      type: "CORTEX_STEP_TYPE_CODE_ACTION",
      codeAction: {
        actionResult: {
          edit: {
            diff: {
              unifiedDiff: { lines },
            },
          },
        },
      },
    };

    const cleaned = sanitizeStepForClient(rawStep) as Record<string, any>;
    const compacted: Array<{ type: string; text: string }> =
      cleaned.codeAction.actionResult.edit.diff.unifiedDiff.lines;

    expect(compacted.length).toBeLessThan(30);
    expect(
      compacted.filter((l) => l.type === "UNIFIED_DIFF_LINE_TYPE_INSERT").length,
    ).toBe(3);
    expect(
      compacted.filter((l) => l.type === "UNIFIED_DIFF_LINE_TYPE_DELETE").length,
    ).toBe(1);
    expect(compacted.some((l) => l.text.includes("行省略"))).toBe(true);
    // Original lines array is not mutated
    expect(rawStep.codeAction.actionResult.edit.diff.unifiedDiff.lines.length).toBe(1500);
  });

  it("caps runaway runCommand.combinedOutput.full while keeping head and tail context", () => {
    const huge = `HEAD_MARKER\n${"x".repeat(120_000)}\nTAIL_MARKER`;
    const rawStep = {
      type: "CORTEX_STEP_TYPE_RUN_COMMAND",
      runCommand: {
        commandLine: "npm test",
        combinedOutput: { full: huge },
      },
    };

    const cleaned = sanitizeStepForClient(rawStep) as Record<string, any>;
    const output: string = cleaned.runCommand.combinedOutput.full;

    expect(output.length).toBeLessThan(70_000);
    expect(output.startsWith("HEAD_MARKER")).toBe(true);
    expect(output.endsWith("TAIL_MARKER")).toBe(true);
    expect(output).toContain("文字省略");
  });
});
