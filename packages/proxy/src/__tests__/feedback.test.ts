import { afterEach, describe, expect, it } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { registerFeedbackRoutes } from "../routes/feedback.js";

const TEST_FILE = join(tmpdir(), `ag-jp-feedback-route-test-${process.pid}.json`);

describe("Local feedback routes (/api/feedback)", () => {
  afterEach(() => {
    delete process.env.AG_JP_FEEDBACK_PATH;
    if (existsSync(TEST_FILE)) {
      try {
        unlinkSync(TEST_FILE);
      } catch {
        // ignore
      }
    }
  });

  it("supports creating, listing, resolving, and deleting AI & user feedback items", async () => {
    process.env.AG_JP_FEEDBACK_PATH = TEST_FILE;
    const app = new Hono();
    registerFeedbackRoutes(app);

    const createRes = await app.request("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "improvement",
        severity: "high",
        source: "ai",
        reporterName: "AIレビュー担当",
        title: "ライトモードのバッジ文字を濃くしたい",
        detail: "白背景でも見やすいコントラストへ調整",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as any;
    expect(created.ok).toBe(true);
    expect(created.item.id).toMatch(/^fb_/);
    expect(created.item.source).toBe("ai");

    const listRes = await app.request("/api/feedback");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    expect(listBody.items.length).toBe(1);
    expect(listBody.issuesUrl).toContain("github.com/ohtake01-cell/antigravity-jp/issues/new");

    const patchRes = await app.request(`/api/feedback/${created.item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "resolved", resolutionNote: "反映済み" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as any;
    expect(patched.item.status).toBe("resolved");
    expect(patched.item.resolvedAt).toBeTruthy();

    const delRes = await app.request(`/api/feedback/${created.item.id}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
  });
});
