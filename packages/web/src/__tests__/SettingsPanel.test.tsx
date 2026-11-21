import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../components/SettingsPanel";
import { api } from "../api/client";
import type { ClientSettings } from "../types";

vi.mock("../api/client", () => ({
  api: {
    models: vi.fn(),
    archivedConversations: vi.fn(),
    updateAnnotations: vi.fn(),
    extensionsOverview: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

const baseSettings: ClientSettings = {
  defaultModel: null,
  defaultPlannerType: "auto",
  plannerModeAutoMigrated: true,
  browserNotificationsEnabled: false,
  targetApp: "all",
};

describe("SettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.models.mockResolvedValue({ clientModelConfigs: [] });
    mockedApi.archivedConversations.mockResolvedValue({
      trajectorySummaries: {
        "conv-arch-1": {
          summary: "古い設計メモ",
          stepCount: 12,
          lastModifiedTime: new Date().toISOString(),
          createdTime: new Date().toISOString(),
          trajectoryId: "t-1",
          status: "CASCADE_RUN_STATUS_UNLOADED",
          workspaces: [{ workspaceFolderAbsoluteUri: "file:///Users/demo/project" }],
          annotations: { archived: true },
        },
      },
    });
    mockedApi.updateAnnotations.mockResolvedValue({
      ok: true,
      id: "conv-arch-1",
      archived: false,
    });
    mockedApi.extensionsOverview.mockResolvedValue({
      ok: true,
      mcpServers: [],
      skills: [],
      plugins: [],
      memories: [],
      globalRules: "",
      paths: {
        mcpConfigPath: "~/.gemini/config/mcp_config.json",
        skillsDir: "~/.gemini/config/skills",
        pluginsDir: "~/.gemini/config/plugins",
        rulesPath: "~/.gemini/config/GEMINI.md",
      },
    });
  });

  it("renders Japanese settings sections and archived conversations list", async () => {
    render(
      <SettingsPanel
        settings={baseSettings}
        onUpdate={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText("設定")).toBeInTheDocument();
    expect(screen.getByText("表示モード（下位 / 上位モデル切替）")).toBeInTheDocument();
    expect(screen.getByText("🌿 シンプル版（下位）")).toBeInTheDocument();
    expect(screen.getByText("⚡ マルチAI版（上位）")).toBeInTheDocument();
    expect(screen.queryByTestId("provider-accounts-section")).not.toBeInTheDocument();
    expect(screen.getByText("接続先AIエンジン")).toBeInTheDocument();
    expect(screen.getByText("既定のモデル")).toBeInTheDocument();
    expect(screen.getByText("既定のモード")).toBeInTheDocument();
    expect(screen.getByText("ブラウザ通知")).toBeInTheDocument();
    expect(screen.getByText("📦 アーカイブ")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("古い設計メモ")).toBeInTheDocument();
    });
    expect(screen.getByText("1件")).toBeInTheDocument();
  });

  it("restores an archived conversation when clicking 取り出す", async () => {
    const onRefresh = vi.fn();
    render(
      <SettingsPanel
        settings={baseSettings}
        onUpdate={vi.fn()}
        onBack={vi.fn()}
        onRefreshConversations={onRefresh}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("古い設計メモ")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("取り出す"));

    await waitFor(() => {
      expect(mockedApi.updateAnnotations).toHaveBeenCalledWith("conv-arch-1", {
        archived: false,
      });
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByText("古い設計メモ")).not.toBeInTheDocument();
    });
  });

  it("auto-heals retired defaultModel to the live server default so the select is never blank", async () => {
    const onUpdate = vi.fn();
    mockedApi.models.mockResolvedValue({
      clientModelConfigs: [
        {
          label: "Gemini 4 Neon (High)",
          modelOrAlias: { model: "MODEL_PLACEHOLDER_M532" },
          supportsImages: true,
          isRecommended: true,
        },
      ],
      defaultOverrideModelConfig: {
        modelOrAlias: { model: "MODEL_PLACEHOLDER_M532" },
      },
    });

    render(
      <SettingsPanel
        settings={{ ...baseSettings, defaultModel: "MODEL_PLACEHOLDER_M36" }}
        onUpdate={onUpdate}
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({
        defaultModel: "MODEL_PLACEHOLDER_M532",
      });
    });
  });

  it("switches theme mode between ダーク / ライト / 自動", () => {
    const onUpdate = vi.fn();
    render(
      <SettingsPanel
        settings={{ ...baseSettings, themeMode: "dark" }}
        onUpdate={onUpdate}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /ライト/ }));
    expect(onUpdate).toHaveBeenCalledWith({ themeMode: "light" });

    fireEvent.click(screen.getByRole("radio", { name: /自動/ }));
    expect(onUpdate).toHaveBeenCalledWith({ themeMode: "auto" });
  });
});
