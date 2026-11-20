import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChatInput } from "../components/ChatInput";

describe("ChatInput", () => {
  const mockOnSend = vi.fn();
  const mockOnStop = vi.fn();
  const mockOnDraftChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(URL, "createObjectURL", {
      writable: true,
      value: vi.fn(() => "blob:mock"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      writable: true,
      value: vi.fn(),
    });
  });

  const defaultProps = {
    onSend: mockOnSend,
    onStop: mockOnStop,
    onDraftChange: mockOnDraftChange,
    isRunning: false,
    draft: "",
  };

  it("renders correctly", () => {
    render(<ChatInput {...defaultProps} />);
    expect(
      screen.getByPlaceholderText("メッセージを入力..."),
    ).toBeInTheDocument();
  });

  it("calls onDraftChange when typing", () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText("メッセージを入力...");
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(mockOnDraftChange).toHaveBeenCalledWith("hello");
  });

  it("blocks oversized svg attachments before sending", async () => {
    const { container } = render(<ChatInput {...defaultProps} />);
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();

    const file = new File(
      [new Uint8Array(1024 * 1024 + 1)],
      "large.svg",
      { type: "image/svg+xml" },
    );

    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByAltText("attachment")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("送信 (Enter)"));

    await waitFor(() => {
      expect(mockOnSend).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "GIF and SVG attachments must stay under",
      );
    });
  });

  it("does not submit on Enter during Japanese IME composition or right after compositionend", () => {
    vi.useFakeTimers();
    try {
      render(<ChatInput {...defaultProps} draft="日本語テスト" />);
      const textarea = screen.getByPlaceholderText("メッセージを入力...");

      // 1. Enter while composition is active
      fireEvent.compositionStart(textarea);
      fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
      expect(mockOnSend).not.toHaveBeenCalled();

      // 2. keyCode 229 (Chromium/WebKit IME processing keyCode)
      fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
      expect(mockOnSend).not.toHaveBeenCalled();

      // 3. Safari/Brave quirk: keydown(Enter) fires immediately after compositionend
      fireEvent.compositionEnd(textarea);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(mockOnSend).not.toHaveBeenCalled();

      // 4. After IME cooldown elapses, genuine Enter sends once
      vi.advanceTimersByTime(100);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(mockOnSend).toHaveBeenCalledTimes(1);
      expect(mockOnSend).toHaveBeenCalledWith(
        "日本語テスト",
        expect.anything(),
        undefined,
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("prevents duplicate submission when Enter fires twice synchronously", () => {
    render(<ChatInput {...defaultProps} draft="頼むぞ" />);
    const textarea = screen.getByPlaceholderText("メッセージを入力...");

    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mockOnSend).toHaveBeenCalledTimes(1);
  });

  it("recovers from stuck IME composing state after blur so Enter submission continues working", () => {
    render(<ChatInput {...defaultProps} draft="復旧テスト" />);
    const textarea = screen.getByPlaceholderText("メッセージを入力...");

    // Simulate IME starting composition and losing focus without firing compositionEnd
    fireEvent.compositionStart(textarea);
    fireEvent.blur(textarea);
    fireEvent.focus(textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mockOnSend).toHaveBeenCalledTimes(1);
  });

  it("renders voice input button and guides user to HTTPS when microphone API is unavailable", async () => {
    render(<ChatInput {...defaultProps} />);
    const voiceBtn = screen.getByRole("button", { name: "音声入力" });
    expect(voiceBtn).toBeInTheDocument();

    fireEvent.click(voiceBtn);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "音声入力は HTTPS またはローカル環境",
      );
    });
  });

  it("uploads any non-image file format (e.g. PDF) and inserts its path mention without rejecting", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/files/upload")) {
          return new Response(
            JSON.stringify({
              ok: true,
              path: "/Users/demo/project/uploads/20261119_abcd_manual.pdf",
              name: "manual.pdf",
              size: 12,
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({}), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      });
    try {
      const { container } = render(<ChatInput {...defaultProps} />);
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput.getAttribute("accept")).toBeNull();

      const pdfFile = new File(["%PDF-1.4 test"], "manual.pdf", {
        type: "application/pdf",
      });
      fireEvent.change(fileInput, { target: { files: [pdfFile] } });

      await waitFor(() => {
        expect(mockOnDraftChange).toHaveBeenCalledWith(
          "@[/Users/demo/project/uploads/20261119_abcd_manual.pdf] ",
        );
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("inserts macOS app paths received from native drag-and-drop events", () => {
    render(<ChatInput {...defaultProps} draft="解析して" />);
    window.dispatchEvent(
      new CustomEvent("antigravity-jp-file-drop", {
        detail: { paths: ["/Applications/Sample.app"] },
      }),
    );
    expect(mockOnDraftChange).toHaveBeenCalledWith(
      "解析して @[/Applications/Sample.app] ",
    );
  });

  it("auto-syncs selected model to the active conversation model when switching chats", async () => {
    const { rerender } = render(
      <ChatInput
        {...defaultProps}
        draft="テスト1"
        conversationId="conv-carbon"
        conversationModel="MODEL_PLACEHOLDER_M437"
        defaultModel="MODEL_PLACEHOLDER_M532"
      />,
    );

    fireEvent.click(screen.getByTitle("送信 (Enter)"));
    await waitFor(() => {
      expect(mockOnSend).toHaveBeenLastCalledWith(
        "テスト1",
        "MODEL_PLACEHOLDER_M437",
        undefined,
        expect.any(String),
      );
    });
    await new Promise((r) => setTimeout(r, 10));

    // Switch to another conversation on Claude Opus
    rerender(
      <ChatInput
        {...defaultProps}
        draft="テスト2"
        conversationId="conv-claude"
        conversationModel="MODEL_PLACEHOLDER_M402"
        defaultModel="MODEL_PLACEHOLDER_M532"
      />,
    );
    fireEvent.click(screen.getByTitle("送信 (Enter)"));
    await waitFor(() => {
      expect(mockOnSend).toHaveBeenLastCalledWith(
        "テスト2",
        "MODEL_PLACEHOLDER_M402",
        undefined,
        expect.any(String),
      );
    });
    await new Promise((r) => setTimeout(r, 10));

    // Switch to a brand-new chat -> falls back to defaultModel
    rerender(
      <ChatInput
        {...defaultProps}
        draft="新規チャット"
        conversationId={null}
        conversationModel={null}
        defaultModel="MODEL_PLACEHOLDER_M532"
      />,
    );
    fireEvent.click(screen.getByTitle("送信 (Enter)"));
    await waitFor(() => {
      expect(mockOnSend).toHaveBeenLastCalledWith(
        "新規チャット",
        "MODEL_PLACEHOLDER_M532",
        undefined,
        expect.any(String),
      );
    });
  });

  it("renders Japanese Local Permissions selector (4 modes) and Antigravity-style voice buttons", () => {
    const onPolicyChange = vi.fn();
    render(
      <ChatInput
        {...defaultProps}
        draft=""
        permissionPolicy="CASCADE_COMMANDS_AUTO_EXECUTION_EAGER"
        onPermissionPolicyChange={onPolicyChange}
      />,
    );

    // Both voice input (draft) and audio orb (auto-send) are visible when draft is empty
    expect(screen.getByRole("button", { name: "音声入力" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "音声で即送信" })).toBeInTheDocument();

    // Open Japanese Local Permissions menu
    const permBtn = screen.getByRole("button", { name: /ローカル実行権限: ターボ/ });
    fireEvent.click(permBtn);
    expect(screen.getByText("ローカル実行権限")).toBeInTheDocument();
    expect(screen.getByText("確認必須")).toBeInTheDocument();
    expect(screen.getByText("標準")).toBeInTheDocument();
    expect(screen.getByText("自動判断")).toBeInTheDocument();
    expect(screen.getByText("既定")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitemradio", { name: /確認必須/ }));
    expect(onPolicyChange).toHaveBeenCalledWith(
      "CASCADE_COMMANDS_AUTO_EXECUTION_OFF",
    );
  });
});
