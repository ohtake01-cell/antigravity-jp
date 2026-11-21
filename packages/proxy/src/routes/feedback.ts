/**
 * /api/feedback routes — ローカル バグ報告・改善提案ボード（AI・ユーザー両対応）
 *
 * 個人環境情報を一切含めず、各ユーザーのローカル設定ディレクトリに保存し、
 * GitHub Issues（ohtake01-cell/antigravity-jp）への安全な報告リンク生成情報も提供する。
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import { resolveCurrentAppVersion } from "./update.js";

export type LocalFeedbackKind = "bug" | "improvement";
export type LocalFeedbackSeverity = "high" | "medium" | "low";
export type LocalFeedbackStatus = "open" | "in_progress" | "resolved";
export type LocalFeedbackSource = "ai" | "user";

export interface LocalFeedbackItem {
  id: string;
  kind: LocalFeedbackKind;
  severity: LocalFeedbackSeverity;
  status: LocalFeedbackStatus;
  source: LocalFeedbackSource;
  reporterName: string;
  title: string;
  detail: string;
  appVersion: string;
  resolutionNote?: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
}

const GITHUB_ISSUES_URL =
  "https://github.com/ohtake01-cell/antigravity-jp/issues/new";

const VALID_KINDS = new Set<LocalFeedbackKind>(["bug", "improvement"]);
const VALID_SEVERITIES = new Set<LocalFeedbackSeverity>([
  "high",
  "medium",
  "low",
]);
const VALID_STATUSES = new Set<LocalFeedbackStatus>([
  "open",
  "in_progress",
  "resolved",
]);
const VALID_SOURCES = new Set<LocalFeedbackSource>(["ai", "user"]);

function resolveFeedbackStorePath(): string {
  if (process.env.AG_JP_FEEDBACK_PATH) {
    return process.env.AG_JP_FEEDBACK_PATH;
  }
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return join(tmpdir(), `ag-jp-vitest-feedback-${process.pid}.json`);
  }
  return join(homedir(), ".gemini", "antigravity", "antigravity_jp_feedback.json");
}

function loadFeedbackItems(): LocalFeedbackItem[] {
  const path = resolveFeedbackStorePath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { items?: LocalFeedbackItem[] };
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function saveFeedbackItems(items: LocalFeedbackItem[]): void {
  const path = resolveFeedbackStorePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: items.slice(0, 120) }, null, 2)}\n`,
    "utf-8",
  );
  renameSync(tmp, path);
}

function sortItems(items: LocalFeedbackItem[]): LocalFeedbackItem[] {
  const rank = (s: LocalFeedbackStatus) =>
    s === "open" ? 0 : s === "in_progress" ? 1 : 2;
  return [...items].sort((a, b) => {
    const sr = rank(a.status) - rank(b.status);
    if (sr !== 0) return sr;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

export function registerFeedbackRoutes(app: Hono): void {
  app.get("/api/feedback", (c) => {
    const statusFilter = c.req.query("status");
    const kindFilter = c.req.query("kind");
    let items = sortItems(loadFeedbackItems());
    if (statusFilter && VALID_STATUSES.has(statusFilter as LocalFeedbackStatus)) {
      items = items.filter((i) => i.status === statusFilter);
    }
    if (kindFilter && VALID_KINDS.has(kindFilter as LocalFeedbackKind)) {
      items = items.filter((i) => i.kind === kindFilter);
    }
    return c.json({
      ok: true,
      items,
      appVersion: resolveCurrentAppVersion(),
      platform: process.platform,
      arch: process.arch,
      issuesUrl: GITHUB_ISSUES_URL,
    });
  });

  app.post("/api/feedback", async (c) => {
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return c.json({ ok: false, error: "invalid_json" }, 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: "invalid_json" }, 400);
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return c.json(
        { ok: false, error: "invalid_title", message: "タイトルは必須です。" },
        400,
      );
    }
    const kind: LocalFeedbackKind =
      typeof body.kind === "string" && VALID_KINDS.has(body.kind as LocalFeedbackKind)
        ? (body.kind as LocalFeedbackKind)
        : "bug";
    const severity: LocalFeedbackSeverity =
      typeof body.severity === "string" &&
      VALID_SEVERITIES.has(body.severity as LocalFeedbackSeverity)
        ? (body.severity as LocalFeedbackSeverity)
        : "medium";
    const source: LocalFeedbackSource =
      typeof body.source === "string" &&
      VALID_SOURCES.has(body.source as LocalFeedbackSource)
        ? (body.source as LocalFeedbackSource)
        : "user";
    const reporterName =
      typeof body.reporterName === "string" && body.reporterName.trim()
        ? body.reporterName.trim().slice(0, 80)
        : source === "ai"
          ? "AIアシスタント"
          : "ユーザー";
    const detail =
      typeof body.detail === "string" ? body.detail.trim().slice(0, 8000) : "";

    const nowIso = new Date().toISOString();
    const item: LocalFeedbackItem = {
      id: `fb_${randomUUID().slice(0, 10)}`,
      kind,
      severity,
      status: "open",
      source,
      reporterName,
      title: title.slice(0, 160),
      detail,
      appVersion: resolveCurrentAppVersion(),
      resolutionNote: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      resolvedAt: null,
    };

    const existing = loadFeedbackItems();
    saveFeedbackItems([item, ...existing]);
    return c.json({ ok: true, item }, 201);
  });

  app.patch("/api/feedback/:id", async (c) => {
    const id = c.req.param("id");
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json();
      body =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      return c.json({ ok: false, error: "invalid_json" }, 400);
    }

    const items = loadFeedbackItems();
    const target = items.find((i) => i.id === id);
    if (!target) {
      return c.json(
        { ok: false, error: "not_found", message: "項目が見つかりません。" },
        404,
      );
    }

    const nowIso = new Date().toISOString();
    if (
      typeof body.status === "string" &&
      VALID_STATUSES.has(body.status as LocalFeedbackStatus)
    ) {
      target.status = body.status as LocalFeedbackStatus;
      target.resolvedAt = target.status === "resolved" ? nowIso : null;
    }
    if (
      typeof body.severity === "string" &&
      VALID_SEVERITIES.has(body.severity as LocalFeedbackSeverity)
    ) {
      target.severity = body.severity as LocalFeedbackSeverity;
    }
    if (typeof body.title === "string" && body.title.trim()) {
      target.title = body.title.trim().slice(0, 160);
    }
    if (typeof body.detail === "string") {
      target.detail = body.detail.trim().slice(0, 8000);
    }
    if (
      typeof body.resolutionNote === "string" ||
      body.resolutionNote === null
    ) {
      target.resolutionNote =
        typeof body.resolutionNote === "string" && body.resolutionNote.trim()
          ? body.resolutionNote.trim().slice(0, 2000)
          : null;
    }
    target.updatedAt = nowIso;
    saveFeedbackItems(items);
    return c.json({ ok: true, item: target }, 200);
  });

  app.delete("/api/feedback/:id", (c) => {
    const id = c.req.param("id");
    const items = loadFeedbackItems();
    const next = items.filter((i) => i.id !== id);
    if (next.length === items.length) {
      return c.json(
        { ok: false, error: "not_found", message: "項目が見つかりません。" },
        404,
      );
    }
    saveFeedbackItems(next);
    return c.json({ ok: true, id }, 200);
  });
}
