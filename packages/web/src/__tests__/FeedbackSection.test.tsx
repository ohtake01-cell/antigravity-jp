import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackSection } from "../components/FeedbackSection";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    feedbackList: vi.fn(),
    createFeedback: vi.fn(),
    updateFeedback: vi.fn(),
    deleteFeedback: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

describe("FeedbackSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.feedbackList.mockResolvedValue({
      ok: true,
      items: [
        {
          id: "fb_local_1",
          kind: "bug",
          severity: "high",
          status: "open",
          source: "ai",
          reporterName: "AIアシスタント",
          title: "ライトモードの視認性確認",
          detail: "一部バッジ文字のコントラスト改善",
          appVersion: "1.5.4",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      appVersion: "1.5.4",
      platform: "darwin",
      arch: "arm64",
      issuesUrl: "https://github.com/ohtake01-cell/antigravity-jp/issues/new",
    });
    mockedApi.createFeedback.mockResolvedValue({
      ok: true,
      item: {
        id: "fb_local_2",
        kind: "improvement",
        severity: "medium",
        status: "open",
        source: "user",
        reporterName: "ユーザー",
        title: "ショートカットを増やしたい",
        detail: "キーボード操作をさらに便利に",
        appVersion: "1.5.4",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
  });

  it("loads local AI feedback and allows submitting new improvement items", async () => {
    render(<FeedbackSection />);

    expect(
      await screen.findByText("ライトモードの視認性確認"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("💡 改善提案"));
    fireEvent.change(screen.getByLabelText("バグ・改善タイトル"), {
      target: { value: "ショートカットを増やしたい" },
    });
    fireEvent.click(screen.getByText("📝 アプリ内に保存"));

    expect(
      await screen.findByText("ショートカットを増やしたい"),
    ).toBeInTheDocument();
  });
});
