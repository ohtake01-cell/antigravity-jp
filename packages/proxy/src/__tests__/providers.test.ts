import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("../routing.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    discovery: {
      getInstances: vi.fn().mockResolvedValue([
        {
          pid: 1234,
          httpsPort: 50001,
          httpPort: 0,
          lspPort: 0,
          csrfToken: "csrf",
          source: "daemon",
          modelCount: 5,
        },
      ]),
    },
  };
});

vi.mock("../routes/models.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fetchMergedLSModels: vi.fn().mockResolvedValue({
      clientModelConfigs: [
        {
          label: "Gemini 4 Neon (High)",
          modelOrAlias: { model: "MODEL_PLACEHOLDER_M532" },
        },
      ],
      defaultOverrideModelConfig: {
        modelOrAlias: { model: "MODEL_PLACEHOLDER_M532" },
      },
    }),
  };
});

const { registerProviderRoutes } = await import("../routes/providers.js");

describe("Providers & Multi-AI routes", () => {
  function createApp() {
    const app = new Hono();
    registerProviderRoutes(app);
    return app;
  }

  it("GET /api/providers returns google, openai, anthropic, and ollama entries", async () => {
    const res = await createApp().request("/api/providers?refresh=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{ id: string; status: string }>;
      extensions: unknown[];
    };
    expect(body.providers.map((p) => p.id)).toEqual([
      "google",
      "openai",
      "anthropic",
      "ollama",
    ]);
    const google = body.providers.find((p) => p.id === "google");
    expect(google?.status).toBe("ready");
    expect(Array.isArray(body.extensions)).toBe(true);
  });

  it("POST /api/providers/:id/login rejects unsupported providers with 400", async () => {
    const res = await createApp().request("/api/providers/google/login", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("validates POST /api/providers/sessions input and supports listing/deleting sessions", async () => {
    const app = createApp();
    const badProvider = await app.request("/api/providers/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "invalid", prompt: "hello" }),
    });
    expect(badProvider.status).toBe(400);

    const emptyPrompt = await app.request("/api/providers/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "ollama", prompt: "   " }),
    });
    expect(emptyPrompt.status).toBe(400);

    const listRes = await app.request("/api/providers/sessions");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { sessions: unknown[] };
    expect(Array.isArray(listBody.sessions)).toBe(true);
  });

  it("validates POST /api/providers/compare requires >= 2 valid providers and non-empty prompt", async () => {
    const app = createApp();
    const oneProvider = await app.request("/api/providers/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: ["openai"], prompt: "比較して" }),
    });
    expect(oneProvider.status).toBe(400);

    const emptyPrompt = await app.request("/api/providers/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: ["openai", "anthropic"], prompt: "" }),
    });
    expect(emptyPrompt.status).toBe(400);
  });

  it("returns 404 on POST /api/providers/sessions/:id/retry for unknown session", async () => {
    const res = await createApp().request(
      "/api/providers/sessions/does-not-exist/retry",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });
});
