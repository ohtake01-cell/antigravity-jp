/**
 * /api/files route — local file preview (images)
 */

import type { Hono } from "hono";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, posix, resolve, win32 } from "node:path";
import { Readable } from "node:stream";
import { homedir, tmpdir } from "node:os";

function isPathBlockedBySafetyPolicy(targetPath: string): { blocked: boolean; reason?: string } {
  const norm = targetPath.toLowerCase();
  if (norm.includes("/.ssh/") || norm.includes("/keychains/") || norm.endsWith("/.env")) {
    return { blocked: true, reason: "保護対象ファイルは開けません" };
  }
  return { blocked: false };
}
function isAppBlockedBySafetyPolicy(_appName: string): { blocked: boolean; reason?: string } {
  return { blocked: false };
}

const IMAGE_EXTS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

const EDITABLE_TEXT_EXTS = new Set([
  ".md",
  ".mdx",
  ".markdown",
  ".txt",
  ".csv",
  ".tsv",
  ".mmd",
  ".mermaid",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".zsh",
  ".swift",
  ".css",
  ".html",
  ".sql",
  ".log",
  ".env.example",
]);

export type WorkbenchFileKind =
  | "markdown"
  | "csv"
  | "mermaid"
  | "pdf"
  | "image"
  | "code";

const MAX_TEXT_READ_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_TEXT_WRITE_BYTES = 4 * 1024 * 1024; // 4 MB

export function detectWorkbenchFileKind(extLower: string): WorkbenchFileKind | null {
  if (extLower === ".md" || extLower === ".mdx" || extLower === ".markdown") {
    return "markdown";
  }
  if (extLower === ".csv" || extLower === ".tsv") {
    return "csv";
  }
  if (extLower === ".mmd" || extLower === ".mermaid") {
    return "mermaid";
  }
  if (extLower === ".pdf") {
    return "pdf";
  }
  if (IMAGE_EXTS[extLower]) {
    return "image";
  }
  if (EDITABLE_TEXT_EXTS.has(extLower)) {
    return "code";
  }
  return null;
}

export function parseFileRefWithLineRange(rawRef: string): {
  cleanRef: string;
  startLine: number | null;
  endLine: number | null;
} {
  const trimmed = rawRef.trim();
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx === -1) {
    return { cleanRef: trimmed, startLine: null, endLine: null };
  }
  const cleanRef = trimmed.slice(0, hashIdx);
  const frag = trimmed.slice(hashIdx + 1);
  const m = /^L(\d+)(?:-L?(\d+))?$/i.exec(frag);
  if (!m) {
    return { cleanRef, startLine: null, endLine: null };
  }
  const startLine = Number.parseInt(m[1], 10);
  const endLine = m[2] ? Number.parseInt(m[2], 10) : startLine;
  return {
    cleanRef,
    startLine: Number.isFinite(startLine) ? startLine : null,
    endLine: Number.isFinite(endLine) ? endLine : null,
  };
}

function getAllowedWorkbenchRoots(): string[] {
  const roots = [homedir()];
  const extra = process.env.AG_JP_ALLOWED_FILE_ROOT?.trim();
  if (extra) {
    roots.push(extra);
  }
  if (process.env.VITEST) {
    roots.push(tmpdir());
    roots.push("/private/var/folders");
    roots.push("/var/folders");
  }
  return roots.map((r) => resolve(r));
}

export function resolveWorkbenchFilePath(rawRef: string): string | null {
  const { cleanRef } = parseFileRefWithLineRange(rawRef);
  if (!cleanRef) return null;

  let localPath: string | null = null;
  if (cleanRef.startsWith("file://")) {
    localPath = fileUriToPath(cleanRef, false);
  } else {
    localPath = cleanRef;
  }
  if (!localPath) return null;

  const resolvedPath = posix.isAbsolute(localPath)
    ? resolve(localPath)
    : resolve(homedir(), localPath);

  const allowedRoots = getAllowedWorkbenchRoots();
  const insideAllowed = allowedRoots.some((root) => {
    const rel = posix.relative(root, resolvedPath);
    return rel === "" || (!rel.startsWith("..") && !posix.isAbsolute(rel));
  });
  if (!insideAllowed) return null;
  if (isPathBlockedBySafetyPolicy(resolvedPath)) return null;
  return resolvedPath;
}

function fileUriToPath(
  fileUri: string,
  useWindowsPaths: boolean,
): string | null {
  try {
    const url = new URL(fileUri);
    if (url.protocol !== "file:") return null;

    const pathname = decodeURIComponent(url.pathname);

    if (!useWindowsPaths) {
      if (url.hostname && url.hostname !== "localhost") {
        return `//${url.hostname}${pathname}`;
      }
      return pathname;
    }

    // Node's fileURLToPath() follows the host runtime OS. This custom branch
    // keeps Windows file:// URIs testable and correctly resolved even when the
    // code runs on a non-Windows host.
    if (url.hostname && url.hostname !== "localhost") {
      return `\\\\${url.hostname}${pathname.replaceAll("/", "\\")}`;
    }

    if (/^\/[A-Za-z]:/.test(pathname)) {
      return pathname.slice(1).replaceAll("/", "\\");
    }

    return pathname.replaceAll("/", "\\");
  } catch {
    return null;
  }
}

function normalizeLegacyPath(
  filePath: string,
  useWindowsPaths: boolean,
): string {
  // Backward-compatibility for old clients that already rewrote file:///C:/...
  // into /C:/... before the URI-safe pipeline existed.
  if (useWindowsPaths && /^\/[A-Za-z]:/.test(filePath)) {
    return filePath.slice(1);
  }
  return filePath;
}

function looksLikeWindowsPath(filePath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(filePath) || /^\\\\/.test(filePath);
}

function inferWindowsPathMode(
  home: string,
  fileRef: string,
  useWindowsPaths?: boolean,
): boolean {
  if (typeof useWindowsPaths === "boolean") {
    return useWindowsPaths;
  }

  if (looksLikeWindowsPath(home)) {
    return true;
  }

  if (home.startsWith("/") && !/^\/[A-Za-z]:/.test(home)) {
    return false;
  }

  if (fileRef.startsWith("file://")) {
    try {
      const url = new URL(fileRef);
      const pathname = decodeURIComponent(url.pathname);
      return (
        (Boolean(url.hostname) && url.hostname !== "localhost") ||
        /^\/[A-Za-z]:/.test(pathname)
      );
    } catch {
      return false;
    }
  }

  return looksLikeWindowsPath(fileRef) || /^\/[A-Za-z]:/.test(fileRef);
}

export function resolveSafeHomeFilePath(
  fileRef: string,
  home = homedir(),
  useWindowsPaths?: boolean,
): string | null {
  const windowsPaths = inferWindowsPathMode(home, fileRef, useWindowsPaths);
  const pathApi = windowsPaths ? win32 : posix;
  const resolvedHome = pathApi.resolve(home);
  const localPath = fileRef.startsWith("file://")
    ? fileUriToPath(fileRef, windowsPaths)
    : normalizeLegacyPath(fileRef, windowsPaths);
  if (!localPath) return null;

  const resolvedPath = pathApi.isAbsolute(localPath)
    ? pathApi.resolve(localPath)
    : pathApi.resolve(resolvedHome, localPath);
  const relativePath = pathApi.relative(resolvedHome, resolvedPath);

  if (
    relativePath.startsWith("..") ||
    pathApi.isAbsolute(relativePath)
  ) {
    return null;
  }

  return resolvedPath;
}

export function registerFileRoutes(app: Hono): void {
  app.get("/api/files", async (c) => {
    const fileRef = c.req.query("uri") ?? c.req.query("path");
    if (!fileRef) {
      return c.json({ error: "Missing 'uri' or 'path' query param" }, 400);
    }

    // Security: only serve files under home dir and outside blocked folders
    const resolved = resolveSafeHomeFilePath(fileRef);
    if (!resolved || isPathBlockedBySafetyPolicy(resolved)) {
      return c.json({ error: "Access denied" }, 403);
    }

    // Only serve images
    const ext = extname(resolved).toLowerCase();
    const mimeType = IMAGE_EXTS[ext];
    if (!mimeType) {
      return c.json({ error: `Unsupported file type: ${ext}` }, 400);
    }

    if (!existsSync(resolved)) {
      return c.json({ error: "File not found" }, 404);
    }

    const stream = createReadStream(resolved);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  });

  app.get("/api/files/apps", (c) => {
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const dirs = ["/Applications", join(homedir(), "Applications")];
    const seen = new Set<string>();
    const apps: Array<{ name: string; fileName: string; path: string }> = [];

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        for (const entry of readdirSync(dir)) {
          if (!entry.toLowerCase().endsWith(".app")) continue;
          const fullPath = join(dir, entry);
          if (seen.has(fullPath)) continue;
          seen.add(fullPath);
          if (
            isAppBlockedBySafetyPolicy(entry) ||
            isAppBlockedBySafetyPolicy(fullPath)
          ) {
            continue;
          }
          const name = entry.replace(/\.app$/i, "");
          if (q && !name.toLowerCase().includes(q) && !entry.toLowerCase().includes(q)) {
            continue;
          }
          apps.push({ name, fileName: entry, path: fullPath });
        }
      } catch {
        // Ignore unreadable app dirs
      }
    }

    apps.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    return c.json({ apps });
  });

  app.post("/api/files/upload", async (c) => {
    const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
    try {
      const form = await c.req.formData();
      const entry = form.get("file");
      if (!entry || typeof entry === "string") {
        return c.json({ ok: false, error: "file is required" }, 400);
      }
      const file = entry as File;
      if (file.size > MAX_UPLOAD_BYTES) {
        return c.json(
          { ok: false, error: "ファイルサイズ上限（50MB）を超えています" },
          413,
        );
      }

      const rawName = basename(file.name || "attachment.bin");
      const safeName =
        rawName
          .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
          .replace(/^\.+/, "")
          .trim() || "attachment.bin";

      let uploadDir = process.env.AG_JP_UPLOAD_DIR?.trim();
      if (!uploadDir) {
        if (process.env.VITEST) {
          uploadDir = join(tmpdir(), `antigravity-jp-vitest-uploads-${process.pid}`);
        } else {
          uploadDir = join(homedir(), ".gemini", "antigravity", "uploads");
        }
      }
      mkdirSync(uploadDir, { recursive: true });

      const stamp = new Date()
        .toISOString()
        .replace(/[-:T.Z]/g, "")
        .slice(0, 14);
      const rand = Math.random().toString(36).slice(2, 6);
      const outPath = join(uploadDir, `${stamp}_${rand}_${safeName}`);
      const buf = Buffer.from(await file.arrayBuffer());
      writeFileSync(outPath, buf);

      return c.json(
        {
          ok: true,
          path: outPath,
          name: safeName,
          size: buf.length,
          mimeType: file.type || "application/octet-stream",
        },
        201,
      );
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : "upload_failed",
        },
        500,
      );
    }
  });

  // ── Phase E: Right-Pane Multi-Format Workbench (/api/files/read, /raw, /write, /recent) ──

  app.get("/api/files/raw", (c) => {
    const fileRef = c.req.query("uri") ?? c.req.query("path") ?? "";
    if (!fileRef) {
      return c.json({ ok: false, error: "Missing 'path' or 'uri'" }, 400);
    }
    const resolved = resolveWorkbenchFilePath(fileRef);
    if (!resolved) {
      return c.json({ ok: false, error: "Access denied" }, 403);
    }
    if (!existsSync(resolved)) {
      return c.json({ ok: false, error: "File not found" }, 404);
    }
    const ext = extname(resolved).toLowerCase();
    const mimeType =
      ext === ".pdf" ? "application/pdf" : IMAGE_EXTS[ext] ?? null;
    if (!mimeType) {
      return c.json({ ok: false, error: `Unsupported binary preview: ${ext}` }, 400);
    }
    const stream = createReadStream(resolved);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "no-cache",
      },
    });
  });

  app.get("/api/files/read", (c) => {
    const fileRef = c.req.query("uri") ?? c.req.query("path") ?? "";
    if (!fileRef) {
      return c.json({ ok: false, error: "Missing 'path' or 'uri'" }, 400);
    }
    const { startLine, endLine } = parseFileRefWithLineRange(fileRef);
    const resolved = resolveWorkbenchFilePath(fileRef);
    if (!resolved) {
      return c.json(
        {
          ok: false,
          error: "blocked_or_outside_allowed_roots",
          message: "安全ポリシーまたは許可ルート外のため開けません。",
        },
        403,
      );
    }
    if (!existsSync(resolved)) {
      return c.json(
        { ok: false, error: "not_found", message: "ファイルが見つかりません。" },
        404,
      );
    }

    let st;
    try {
      st = statSync(resolved);
    } catch {
      return c.json({ ok: false, error: "stat_failed" }, 500);
    }
    if (!st.isFile()) {
      return c.json(
        { ok: false, error: "not_a_file", message: "ディレクトリは直接開けません。" },
        400,
      );
    }

    const ext = extname(resolved).toLowerCase();
    const kind = detectWorkbenchFileKind(ext);
    if (!kind) {
      return c.json(
        {
          ok: false,
          error: "unsupported_format",
          message: `未対応のファイル形式です (${ext || "拡張子なし"})`,
        },
        400,
      );
    }

    const encodedPath = encodeURIComponent(resolved);
    if (kind === "pdf" || kind === "image") {
      return c.json({
        ok: true,
        path: resolved,
        name: basename(resolved),
        ext,
        kind,
        size: st.size,
        mtime: st.mtime.toISOString(),
        content: null,
        rawUrl: `/api/files/raw?path=${encodedPath}`,
        editable: false,
        startLine,
        endLine,
      });
    }

    if (st.size > MAX_TEXT_READ_BYTES) {
      return c.json(
        {
          ok: false,
          error: "file_too_large",
          message: "テキストプレビュー上限（2MB）を超えています。",
        },
        413,
      );
    }

    const content = readFileSync(resolved, "utf-8");
    return c.json({
      ok: true,
      path: resolved,
      name: basename(resolved),
      ext,
      kind,
      size: st.size,
      mtime: st.mtime.toISOString(),
      content,
      rawUrl: null,
      editable: EDITABLE_TEXT_EXTS.has(ext),
      startLine,
      endLine,
    });
  });

  app.put("/api/files/write", async (c) => {
    let body: Record<string, unknown> | null = null;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: "invalid_json" }, 400);
    }
    const rawPath = typeof body?.path === "string" ? body.path.trim() : "";
    const content = typeof body?.content === "string" ? body.content : null;
    if (!rawPath || content === null) {
      return c.json(
        { ok: false, error: "missing_fields", message: "path と content が必要です。" },
        400,
      );
    }

    const resolved = resolveWorkbenchFilePath(rawPath);
    if (!resolved) {
      return c.json(
        {
          ok: false,
          error: "blocked_or_outside_allowed_roots",
          message: "安全ポリシーまたは許可ルート外のため保存できません。",
        },
        403,
      );
    }

    const ext = extname(resolved).toLowerCase();
    if (!EDITABLE_TEXT_EXTS.has(ext)) {
      return c.json(
        {
          ok: false,
          error: "not_editable",
          message: `この拡張子 (${ext || "なし"}) は直接保存の対象外です。`,
        },
        400,
      );
    }

    const byteLen = Buffer.byteLength(content, "utf-8");
    if (byteLen > MAX_TEXT_WRITE_BYTES) {
      return c.json(
        { ok: false, error: "payload_too_large", message: "保存サイズ上限（4MB）を超えています。" },
        413,
      );
    }

    try {
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, content, "utf-8");
      const st = statSync(resolved);
      return c.json({
        ok: true,
        path: resolved,
        bytesWritten: byteLen,
        mtime: st.mtime.toISOString(),
      });
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: "write_failed",
          message: err instanceof Error ? err.message : "書き込みに失敗しました。",
        },
        500,
      );
    }
  });

  app.get("/api/files/recent", (c) => {
    const workspaceRef = c.req.query("workspace") ?? "";
    const items: Array<{
      path: string;
      name: string;
      kind: WorkbenchFileKind;
      mtime: string;
      size: number;
      source: "artifact" | "workspace";
    }> = [];
    const seen = new Set<string>();

    const collectDir = (
      dirPath: string,
      source: "artifact" | "workspace",
      maxEntries = 30,
    ) => {
      if (!existsSync(dirPath) || isPathBlockedBySafetyPolicy(dirPath)) return;
      try {
        const entries = readdirSync(dirPath).slice(0, maxEntries);
        for (const entry of entries) {
          if (
            entry.startsWith(".") ||
            entry.endsWith(".metadata.json") ||
            entry.includes(".resolved")
          ) {
            continue;
          }
          const full = join(dirPath, entry);
          if (seen.has(full) || isPathBlockedBySafetyPolicy(full)) continue;
          let st;
          try {
            st = statSync(full);
          } catch {
            continue;
          }
          if (!st.isFile()) continue;
          const ext = extname(entry).toLowerCase();
          const kind = detectWorkbenchFileKind(ext);
          if (
            !kind ||
            (kind === "code" && ext !== ".json" && ext !== ".txt")
          ) {
            continue;
          }
          seen.add(full);
          items.push({
            path: full,
            name: entry,
            kind,
            mtime: st.mtime.toISOString(),
            size: st.size,
            source,
          });
        }
      } catch {
        // Ignore unreadable dir
      }
    };

    // 1. Recent Antigravity brain artifacts
    const brainRoot = join(homedir(), ".gemini", "antigravity", "brain");
    if (existsSync(brainRoot)) {
      try {
        const convDirs = readdirSync(brainRoot).slice(0, 40);
        for (const conv of convDirs) {
          if (conv.startsWith(".")) continue;
          collectDir(join(brainRoot, conv), "artifact", 12);
        }
      } catch {
        // Ignore
      }
    }

    // 2. Current workspace top-level docs
    if (workspaceRef) {
      const wsPath = resolveWorkbenchFilePath(workspaceRef);
      if (wsPath) {
        collectDir(wsPath, "workspace", 40);
      }
    } else {
      collectDir(homedir(), "workspace", 20);
    }

    items.sort((a, b) => b.mtime.localeCompare(a.mtime));
    return c.json({ ok: true, files: items.slice(0, 24) });
  });
}
