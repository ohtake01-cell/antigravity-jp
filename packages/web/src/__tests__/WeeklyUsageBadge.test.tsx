import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WeeklyUsageBadge, formatCompactTokens } from "../components/WeeklyUsageBadge";
import * as client from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    weeklyUsage: vi.fn(),
    models: vi.fn(),
  },
}));

describe("WeeklyUsageBadge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.api.models).mockResolvedValue({
      clientModelConfigs: [
        {
          label: "Gemini 4 Carbon (Medium)",
          modelOrAlias: { model: "MODEL_PLACEHOLDER_M437" },
          supportsImages: true,
          isRecommended: true,
          quotaInfo: {
            remainingFraction: 0.76,
            resetTime: "2026-11-18T18:51:24Z",
          },
        },
      ],
      defaultOverrideModelConfig: {
        modelOrAlias: { model: "MODEL_PLACEHOLDER_M437" },
      },
    });
    vi.mocked(client.api.weeklyUsage).mockResolvedValue({
      updated_at: "2026-11-19T03:00:00+09:00",
      window: { start_date: "2026-11-13", end_date: "2026-11-19", days: 7 },
      gear: {
        active_tokens: 249_800_000,
        uncached_input_tokens: 233_000_000,
        output_tokens: 16_800_000,
        cached_input_tokens: 3_380_000_000,
        gross_tokens: 3_629_800_000,
        conversations: 150,
        weekly_quota: null,
      },
      codex: {
        active_tokens: 42_200_000,
        uncached_input_tokens: 41_700_000,
        output_tokens: 500_000,
        cached_input_tokens: 305_000_000,
        gross_tokens: 347_200_000,
        conversations: 205,
        weekly_quota: {
          used_percent: 95.0,
          remaining_percent: 5.0,
          resets_at_iso: "2026-11-20T13:51:00+09:00",
        },
      },
      code: {
        active_tokens: 65_300_000,
        uncached_input_tokens: 55_500_000,
        output_tokens: 9_800_000,
        cached_input_tokens: 1_080_000_000,
        gross_tokens: 1_145_300_000,
        conversations: 69,
        weekly_quota: {
          used_percent: 32.0,
          remaining_percent: 68.0,
          resets_at_iso: "2026-11-22T09:00:00+09:00",
        },
      },
      combined: {
        active_tokens: 357_300_000,
        gross_tokens: 5_122_300_000,
      },
      daily: [
        {
          date: "2026-11-19",
          label: "11/19(木)",
          gear_active: 35_000_000,
          codex_active: 5_000_000,
          code_active: 10_000_000,
          total_active: 50_000_000,
          gear_gross: 400_000_000,
          total_gross: 500_000_000,
        },
      ],
    });
  });

  it("formats compact token numbers cleanly", () => {
    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(42_164_064)).toBe("42.2M");
    expect(formatCompactTokens(249_777_058)).toBe("250M");
    expect(formatCompactTokens(3_629_283_107)).toBe("3.63B");
  });

  it("displays Gemini remaining percentage in the pill and weekly details in the dropdown", async () => {
    render(<WeeklyUsageBadge selectedModel="MODEL_PLACEHOLDER_M437" />);
    const pillButton = screen.getByTitle(
      "Gemini公式枠の残り%と週間トークン消費を表示",
    );
    await waitFor(() => {
      expect(pillButton).toHaveTextContent("残 76%");
    });

    fireEvent.click(pillButton);
    expect(screen.getByText("週間トークン消費 ＆ 残り枠")).toBeInTheDocument();
    expect(screen.getByText("Antigravity (Gemini)")).toBeInTheDocument();
    expect(screen.getByText("250M tok")).toBeInTheDocument();
    expect(screen.getByText(/残り 76%/)).toBeInTheDocument();
  });

  it("falls back to weekly token count in the pill when model quota is unavailable", async () => {
    vi.mocked(client.api.models).mockResolvedValue({
      clientModelConfigs: [],
    });
    render(<WeeklyUsageBadge selectedModel="MODEL_PLACEHOLDER_M437" />);
    const pillButton = screen.getByTitle(
      "Gemini公式枠の残り%と週間トークン消費を表示",
    );
    await waitFor(() => {
      expect(pillButton).toHaveTextContent("週 250M");
    });
  });
});
