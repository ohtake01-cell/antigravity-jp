import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactWorkbench } from "../components/ArtifactWorkbench";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    readWorkbenchFile: vi.fn(),
    writeWorkbenchFile: vi.fn(),
    recentWorkbenchFiles: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

describe("ArtifactWorkbench (Phase E Multi-Format Viewer & Editor)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.recentWorkbenchFiles.mockResolvedValue({
      ok: true,
      files: [
        {
          path: "/Users/demo/project/spec.md",
          name: "spec.md",
          kind: "markdown",
          mtime: "2026-11-20T04:00:00.000Z",
          size: 120,
          source: "workspace",
        },
      ],
    });
    mockedApi.writeWorkbenchFile.mockResolvedValue({
      ok: true,
      path: "/Users/demo/project/spec.md",
      bytesWritten: 160,
      mtime: "2026-11-20T04:10:00.000Z",
    });
  });

  it("renders Markdown with offline Mermaid SVG flowchart and supports direct editing & saving", async () => {
    mockedApi.readWorkbenchFile.mockResolvedValue({
      ok: true,
      path: "/Users/demo/project/spec.md",
      name: "spec.md",
      ext: ".md",
      kind: "markdown",
      size: 150,
      mtime: "2026-11-20T04:00:00.000Z",
      content:
        "# アーキテクチャ\n\n```mermaid\nflowchart LR\n  A[チャット] --> B[検証]\n```\n",
      rawUrl: null,
      editable: true,
    });

    render(
      <ArtifactWorkbench
        isOpen={true}
        initialFileRef="file:///Users/demo/project/spec.md"
        currentWorkspaceUri="file:///Users/demo/project"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("アーキテクチャ")).toBeInTheDocument();
    });
    expect(screen.getByTestId("mermaid-diagram")).toBeInTheDocument();
    expect(screen.getByText("検証")).toBeInTheDocument();

    // Switch to edit mode, edit content, and save
    fireEvent.click(screen.getByRole("tab", { name: "✏️ 編集" }));
    const editor = screen.getByLabelText("ファイル直接編集エディタ");
    fireEvent.change(editor, {
      target: { value: "# アーキテクチャ更新済み\n" },
    });
    expect(screen.getByText("● 未保存")).toBeInTheDocument();

    fireEvent.click(screen.getByText("💾 保存"));
    await waitFor(() => {
      expect(mockedApi.writeWorkbenchFile).toHaveBeenCalledWith(
        "/Users/demo/project/spec.md",
        "# アーキテクチャ更新済み\n",
      );
    });
    expect(screen.getByText("✓ 保存しました")).toBeInTheDocument();
  });

  it("renders CSV table with search filter & column sorting, and renders PDF iframe", async () => {
    mockedApi.readWorkbenchFile.mockResolvedValueOnce({
      ok: true,
      path: "/Users/demo/project/bench.csv",
      name: "bench.csv",
      ext: ".csv",
      kind: "csv",
      size: 90,
      mtime: "2026-11-20T04:00:00.000Z",
      content: "model,score\nGemini,98.1\nGPT,73.8\n",
      rawUrl: null,
      editable: true,
    });

    const { rerender } = render(
      <ArtifactWorkbench
        isOpen={true}
        initialFileRef="/Users/demo/project/bench.csv"
        currentWorkspaceUri="file:///Users/demo/project"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("2行 × 2列")).toBeInTheDocument();
    });
    expect(screen.getByText("98.1")).toBeInTheDocument();

    // Filter rows
    fireEvent.change(screen.getByLabelText("表データを絞り込み"), {
      target: { value: "Gemini" },
    });
    expect(screen.getByText("1行 × 2列")).toBeInTheDocument();
    expect(screen.queryByText("73.8")).not.toBeInTheDocument();

    // Switch to PDF preview
    mockedApi.readWorkbenchFile.mockResolvedValueOnce({
      ok: true,
      path: "/Users/demo/project/report.pdf",
      name: "report.pdf",
      ext: ".pdf",
      kind: "pdf",
      size: 4096,
      mtime: "2026-11-20T04:05:00.000Z",
      content: null,
      rawUrl: "/api/files/raw?path=%2FVolumes%2FAI%2Freport.pdf",
      editable: false,
    });

    rerender(
      <ArtifactWorkbench
        isOpen={true}
        initialFileRef="/Users/demo/project/report.pdf"
        currentWorkspaceUri="file:///Users/demo/project"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByTitle("PDFプレビュー: report.pdf"),
      ).toBeInTheDocument();
    });
  });
});
