import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelector, formatMobileSelectorBase } from "../components/ModelSelector";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    models: vi.fn(),
    modelCatalog: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

describe("ModelSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.models.mockResolvedValue({
      clientModelConfigs: [
        {
          label: "Gemini 4 Carbon (Medium)",
          modelOrAlias: { model: "M_CARBON" },
          supportsImages: true,
          isRecommended: true,
          tagTitle: "New",
        },
        {
          label: "Claude Opus 5.5 (High)",
          modelOrAlias: { model: "M_CLAUDE" },
          supportsImages: true,
          isRecommended: false,
        },
      ],
      defaultOverrideModelConfig: { modelOrAlias: { model: "M_CARBON" } },
    });
    mockedApi.modelCatalog.mockResolvedValue({
      updatedAt: "2026-11-19T03:00:00Z",
      providers: {
        google: {
          provider: "google",
          displayName: "Google Gemini / Antigravity",
          activeModelId: "M_CARBON",
          activeModelLabel: "Gemini 4 Carbon (Medium)",
          syncedAt: "2026-11-19T03:00:00Z",
          models: [],
        },
        openai: {
          provider: "openai",
          displayName: "OpenAI / Codex",
          activeModelId: "gpt-6.2-sol",
          activeModelLabel: "GPT-6.2-Sol (ultra)",
          syncedAt: "2026-11-19T03:00:00Z",
          models: [
            {
              id: "gpt-6.2-sol",
              label: "GPT-6.2-Sol",
              isNew: true,
              selectableInChat: false,
              source: "codex-cache",
            },
            {
              id: "gpt-6.2-astra",
              label: "GPT-6.2-Astra",
              isNew: true,
              selectableInChat: false,
              source: "codex-cache",
            },
          ],
        },
        anthropic: {
          provider: "anthropic",
          displayName: "Anthropic / Claude",
          activeModelId: "claude-fable-5-2",
          activeModelLabel: "Claude Fable 5.2",
          syncedAt: "2026-11-19T03:00:00Z",
          models: [],
        },
      },
    });
  });

  it("displays provider-grouped selectable models and auto-discovered OpenAI models", async () => {
    const onSelect = vi.fn();
    render(<ModelSelector selectedModel="M_CARBON" onSelect={onSelect} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Gemini 4 Carbon \(Medium\)/ }),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByRole("button", { name: /Gemini 4 Carbon \(Medium\)/ }),
    );

    expect(screen.getByText("Google Gemini")).toBeInTheDocument();
    expect(screen.getByText("Anthropic Claude")).toBeInTheDocument();
    expect(
      screen.getByText("OpenAI 最新モデル（Codex自動同期）"),
    ).toBeInTheDocument();
    expect(screen.getByText("GPT-6.2-Sol")).toBeInTheDocument();
    expect(screen.getByText("GPT-6.2-Astra")).toBeInTheDocument();
    expect(screen.getByText("Codex使用中")).toBeInTheDocument();

    await userEvent.click(screen.getByTitle("最新モデル一覧を再取得"));
    expect(mockedApi.modelCatalog).toHaveBeenCalledWith(true);
  });

  it("auto-heals retired or missing default model and shows live default label immediately", async () => {
    const onSelect = vi.fn();
    const onAutoHeal = vi.fn();
    render(
      <ModelSelector
        selectedModel="MODEL_PLACEHOLDER_M36"
        onSelect={onSelect}
        onAutoHeal={onAutoHeal}
      />,
    );

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith("M_CARBON");
      expect(onAutoHeal).toHaveBeenCalledWith("M_CARBON");
    });
    expect(
      screen.getByRole("button", { name: /Gemini 4 Carbon \(Medium\)/ }),
    ).toBeInTheDocument();
  });

  it("groups model tier variants (Low / Medium / High / XHigh) and selects chosen tier", async () => {
    mockedApi.models.mockResolvedValue({
      clientModelConfigs: [
        {
          label: "Gemini 4 Neon (High)",
          modelOrAlias: { model: "M_NEON_HIGH" },
          supportsImages: true,
          isRecommended: true,
          tagTitle: "New",
          quotaInfo: { remainingFraction: 0.9 },
        },
        {
          label: "Gemini 4 Neon (XHigh)",
          modelOrAlias: { model: "M_NEON_XHIGH" },
          supportsImages: true,
          isRecommended: false,
          tagTitle: "New",
          quotaInfo: { remainingFraction: 0.9 },
        },
        {
          label: "Gemini 4 Neon (Medium)",
          modelOrAlias: { model: "M_NEON_MED" },
          supportsImages: true,
          isRecommended: false,
          tagTitle: "New",
          quotaInfo: { remainingFraction: 0.9 },
        },
        {
          label: "Gemini 4 Neon (Low)",
          modelOrAlias: { model: "M_NEON_LOW" },
          supportsImages: true,
          isRecommended: false,
          tagTitle: "New",
          quotaInfo: { remainingFraction: 0.9 },
        },
      ],
      defaultOverrideModelConfig: { modelOrAlias: { model: "M_NEON_MED" } },
    });

    const onSelect = vi.fn();
    render(<ModelSelector selectedModel="M_NEON_MED" onSelect={onSelect} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Gemini 4 Neon \(Medium\)/ }),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByRole("button", { name: /Gemini 4 Neon \(Medium\)/ }),
    );

    const lowBtn = screen.getByRole("button", { name: "Gemini 4 Neon (Low)" });
    const medBtn = screen.getByRole("button", { name: "Gemini 4 Neon (Medium)" });
    const highBtn = screen.getByRole("button", { name: "Gemini 4 Neon (High)" });
    const xhighBtn = screen.getByRole("button", { name: "Gemini 4 Neon (XHigh)" });

    expect(lowBtn).toHaveTextContent("Low");
    expect(medBtn).toHaveTextContent("Medium");
    expect(highBtn).toHaveTextContent("High");
    expect(xhighBtn).toHaveTextContent("XHigh");
    expect(medBtn).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(highBtn);
    expect(onSelect).toHaveBeenCalledWith("M_NEON_HIGH");
  });

  it("formats compact mobile base labels so Gemini 4 variants stay distinguishable on narrow screens", async () => {
    expect(formatMobileSelectorBase("Gemini 4 Neon")).toBe("Neon");
    expect(formatMobileSelectorBase("Gemini 4 Carbon")).toBe("Carbon");
    expect(formatMobileSelectorBase("Gemini 3.8 Flash")).toBe("Flash 3.8");
    expect(formatMobileSelectorBase("Claude Opus 5.5")).toBe("Opus 5.5");
    expect(formatMobileSelectorBase("Orchestrator (Neon)")).toBe("Orch · Neon");

    const { container } = render(
      <ModelSelector selectedModel="M_CARBON" onSelect={vi.fn()} />,
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Gemini 4 Carbon \(Medium\)/ }),
      ).toBeInTheDocument();
    });
    const shortSpan = container.querySelector(".model-selector-base-short");
    expect(shortSpan?.textContent).toBe("Carbon");
  });
});
