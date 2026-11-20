import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodePbtxtString,
  parseAnnotationPbtxt,
  readConversationAnnotation,
} from "../annotations.js";

const mockRpcForConversation = vi.fn();

vi.mock("../routing.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    rpcForConversation: mockRpcForConversation,
  };
});

const { registerConversationRoutes } = await import(
  "../routes/conversations.js"
);

describe("annotations.ts", () => {
  let tempDir: string | null = null;
  const origEnv = process.env.AG_JP_ANNOTATIONS_DIR;

  afterEach(async () => {
    if (origEnv === undefined) {
      delete process.env.AG_JP_ANNOTATIONS_DIR;
    } else {
      process.env.AG_JP_ANNOTATIONS_DIR = origEnv;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("decodes UTF-8 octal-escaped Japanese titles from pbtxt", () => {
    // "日本語" in UTF-8 bytes: E6 97 A5 E6 9C AC E8 AA 9E
    // octal: \346\227\245\346\234\254\350\252\236
    const decoded = decodePbtxtString(
      "\\346\\227\\245\\346\\234\\254\\350\\252\\236\\t\\\"テスト\\\"",
    );
    expect(decoded).toBe('日本語\t"テスト"');
  });

  it("parses archived, pinned, and UTF-8/octal title from pbtxt", () => {
    const raw = `
archived: true
pinned: true
title: "\\346\\227\\245\\346\\234\\254\\350\\252\\236チャット"
`;
    const parsed = parseAnnotationPbtxt(raw);
    expect(parsed).toEqual({
      archived: true,
      pinned: true,
      title: "日本語チャット",
    });
  });

  it("parses false booleans and raw UTF-8 titles", () => {
    const raw = `archived: false\npinned: false\ntitle: "プロジェクト設計"\n`;
    expect(parseAnnotationPbtxt(raw)).toEqual({
      archived: false,
      pinned: false,
      title: "プロジェクト設計",
    });
  });

  it("reads annotation file from AG_JP_ANNOTATIONS_DIR and blocks path traversal", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ag-jp-ann-"));
    process.env.AG_JP_ANNOTATIONS_DIR = tempDir;

    await writeFile(
      join(tempDir, "conv-123.pbtxt"),
      'archived: true\npinned: false\ntitle: "保存テスト"\n',
      "utf-8",
    );

    const ann = await readConversationAnnotation("conv-123");
    expect(ann).toEqual({
      archived: true,
      pinned: false,
      title: "保存テスト",
    });

    expect(await readConversationAnnotation("../etc/passwd")).toBeNull();
    expect(await readConversationAnnotation("nonexistent-id")).toBeNull();
  });
});

describe("PATCH /api/conversations/:id/annotations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createApp() {
    const app = new Hono();
    registerConversationRoutes(app);
    return app;
  }

  it("forwards title, pinned, archived to UpdateConversationAnnotations with mergeAnnotations: true", async () => {
    mockRpcForConversation.mockResolvedValue({ ok: true });

    const res = await createApp().request(
      "/api/conversations/conv-abc/annotations",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "  新しい名前  ",
          pinned: true,
          archived: false,
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      id: "conv-abc",
      title: "新しい名前",
      pinned: true,
      archived: false,
    });
    expect(mockRpcForConversation).toHaveBeenCalledWith(
      "UpdateConversationAnnotations",
      "conv-abc",
      expect.objectContaining({
        cascadeId: "conv-abc",
        annotations: expect.objectContaining({
          title: "新しい名前",
          pinned: true,
          archived: false,
        }),
        mergeAnnotations: true,
      }),
      undefined,
      false,
      undefined,
    );
  });

  it("rejects empty annotation patch with 400", async () => {
    const res = await createApp().request(
      "/api/conversations/conv-abc/annotations",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
    expect(mockRpcForConversation).not.toHaveBeenCalled();
  });
});
