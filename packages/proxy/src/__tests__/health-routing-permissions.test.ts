import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  sortInstancesByHealth,
  type LSInstance,
} from "../discovery.js";

const mockRpcAny = vi.fn();

vi.mock("../routing.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    rpcAny: mockRpcAny,
  };
});

const {
  registerPermissionAndVoiceRoutes,
  protoToLocalPermission,
  localPermissionToProto,
} = await import("../routes/permissions.js");

const makeInst = (overrides: Partial<LSInstance> = {}): LSInstance => ({
  pid: 1001,
  httpsPort: 50001,
  httpPort: 0,
  lspPort: 0,
  csrfToken: "csrf",
  source: "daemon",
  ...overrides,
});

describe("LS model health ranking", () => {
  it("ranks healthy LS instances above unknown and 0-model unhealthy ones", () => {
    const unhealthy = makeInst({ pid: 1, modelCount: 0 });
    const unknown = makeInst({ pid: 2 });
    const healthyFew = makeInst({ pid: 3, modelCount: 2 });
    const healthyMany = makeInst({ pid: 4, modelCount: 8 });

    const ranked = sortInstancesByHealth([
      unhealthy,
      unknown,
      healthyFew,
      healthyMany,
    ]);
    expect(ranked.map((i) => i.pid)).toEqual([4, 3, 2, 1]);
  });
});

describe("Permissions routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createApp() {
    const app = new Hono();
    registerPermissionAndVoiceRoutes(app);
    return app;
  }

  it("maps proto presets accurately", () => {
    expect(protoToLocalPermission("AGENT_PERMISSION_PRESET_REQUEST_REVIEW")).toBe(
      "request_review",
    );
    expect(protoToLocalPermission("AGENT_PERMISSION_PRESET_DEFAULT")).toBe(
      "default",
    );
    expect(protoToLocalPermission("AGENT_PERMISSION_PRESET_AUTO")).toBe("auto");
    expect(protoToLocalPermission("AGENT_PERMISSION_PRESET_TURBO")).toBe("turbo");
    expect(localPermissionToProto("turbo")).toBe("AGENT_PERMISSION_PRESET_TURBO");
    expect(localPermissionToProto("invalid")).toBeUndefined();
  });

  it("GET /api/permissions returns normalized preset from LS", async () => {
    mockRpcAny.mockResolvedValue({
      globalPreset: "AGENT_PERMISSION_PRESET_TURBO",
      globalArtifactReviewMode: "ARTIFACT_REVIEW_MODE_ALWAYS",
    });

    const res = await createApp().request("/api/permissions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      supported: true,
      preset: "turbo",
      rawPreset: "AGENT_PERMISSION_PRESET_TURBO",
      artifactReviewMode: "ARTIFACT_REVIEW_MODE_ALWAYS",
    });
  });

  it("PATCH /api/permissions calls UpdatePermissionSettings", async () => {
    mockRpcAny.mockResolvedValue({});
    const res = await createApp().request("/api/permissions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "auto" }),
    });

    expect(res.status).toBe(200);
    expect(mockRpcAny).toHaveBeenCalledWith(
      "UpdatePermissionSettings",
      { preset: "AGENT_PERMISSION_PRESET_AUTO" },
      undefined,
    );
  });
});
