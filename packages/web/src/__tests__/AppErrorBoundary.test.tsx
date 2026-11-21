import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AppErrorBoundary,
  isChunkLoadError,
} from "../components/AppErrorBoundary";

function Boom(): never {
  throw new Error("テスト用の予期せぬ例外");
}

describe("AppErrorBoundary", () => {
  it("detects dynamic import / Vite stale chunk errors", () => {
    expect(
      isChunkLoadError(
        new TypeError(
          "Failed to fetch dynamically imported module: https://example.com/assets/AgentMonitorPanel-abc.js",
        ),
      ),
    ).toBe(true);
    expect(
      isChunkLoadError(new Error("Importing a module script failed.")),
    ).toBe(true);
    expect(isChunkLoadError(new Error("通常のエラー"))).toBe(false);
  });

  it("catches render errors and renders Japanese recovery UI instead of a blank screen", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>,
      );

      expect(screen.getByTestId("app-error-boundary")).toBeInTheDocument();
      expect(
        screen.getByText(/画面の表示中にエラーが発生しました/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "画面を再読み込み" }),
      ).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("isolates panel errors inside panel variant without crashing the whole app", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onClose = vi.fn();
    try {
      render(
        <AppErrorBoundary variant="panel" onClose={onClose}>
          <Boom />
        </AppErrorBoundary>,
      );

      expect(screen.getByTestId("panel-error-boundary")).toBeInTheDocument();
      expect(
        screen.getByText(/パネルの表示中にエラーが発生しました/),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "閉じる" })).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });
});
