/**
 * Antigravity 日本語版 ローカルブリッジサーバー
 *
 * Hono HTTP / WebSocket サーバーとしてローカルの Antigravity Language Server と通信し、
 * ビルド済みの日本語 Web UI（packages/web/dist）も一体配信できる構成。
 */

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAdaptorServer } from "@hono/node-server";

import { discovery, extractTargetAppDataDir } from "./routing.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerRpcPassthroughRoutes } from "./routes/rpcPassthrough.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerVoiceRoutes } from "./routes/voice.js";
import { registerJpRuleRoutes } from "./routes/jpRule.js";
import { registerPermissionAndVoiceRoutes } from "./routes/permissions.js";
import { registerProviderRoutes } from "./routes/providers.js";
import {
  assertSupportedListenHost,
  formatListenAddress,
  resolveProxyHost,
} from "./exposure.js";
import { getAllowedOrigins, resolveCorsOrigin } from "./origins.js";
import { setupWebSocket } from "./ws.js";
import { stopStandaloneCore } from "./core-manager.js";

const PORT = parseInt(process.env.PORTA_PORT ?? "3470", 10);
const HOST = resolveProxyHost();

assertSupportedListenHost(HOST, process.env);

const app = new Hono();

// ── Middleware ──

const ALLOWED_ORIGINS = getAllowedOrigins();

app.use(
  "*",
  cors({
    origin: (origin) => resolveCorsOrigin(origin, ALLOWED_ORIGINS),
  }),
);

// ── Health ──

app.get("/api/health", async (c) => {
  const instances = await discovery.getInstances(
    false,
    extractTargetAppDataDir(c),
  );
  return c.json({
    status: "ok",
    appName: "Antigravity 日本語版",
    proxy: { port: PORT, uptime: process.uptime() },
    languageServers: instances.map((i) => ({
      pid: i.pid,
      httpsPort: i.httpsPort,
      workspaceId: i.workspaceId,
      appDataDir: i.appDataDir,
      source: i.source,
      modelCount: i.modelCount,
      modelHealthy: typeof i.modelCount === "number" ? i.modelCount > 0 : undefined,
    })),
  });
});

// ── Routes ──

registerConversationRoutes(app);
registerModelRoutes(app);
registerWorkspaceRoutes(app);
registerFileRoutes(app);
registerSearchRoutes(app);
registerRpcPassthroughRoutes(app);
registerUsageRoutes(app);
registerVoiceRoutes(app);
registerJpRuleRoutes(app);
registerPermissionAndVoiceRoutes(app);
registerProviderRoutes(app);

// ── ビルド済み Web UI の一体配信（単体起動モード） ──

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

function resolveWebDistDir(): string | null {
  const candidates = [
    process.env.PORTA_WEB_DIST_DIR,
    resolve(fileURLToPath(new URL("../../web/dist", import.meta.url))),
    resolve(fileURLToPath(new URL("../web-dist", import.meta.url))),
  ].filter((p): p is string => Boolean(p));

  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) {
      return dir;
    }
  }
  return null;
}

const webDistDir = resolveWebDistDir();
if (webDistDir) {
  const resolvedDist = resolve(webDistDir);

  app.get("*", async (c) => {
    const reqPath = c.req.path;
    if (reqPath.startsWith("/api/") || reqPath === "/ws") {
      return c.notFound();
    }

    const rel = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
    const safePath = resolve(resolvedDist, normalize(rel));

    if (
      safePath.startsWith(resolvedDist) &&
      existsSync(safePath) &&
      statSync(safePath).isFile()
    ) {
      const content = await readFile(safePath);
      const mime = MIME_TYPES[extname(safePath).toLowerCase()] ?? "application/octet-stream";
      const isHashedAsset = rel.startsWith("assets/");
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Cache-Control": isHashedAsset
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    }

    // SPA フォールバック
    const indexHtml = await readFile(join(resolvedDist, "index.html"));
    return new Response(indexHtml, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  });
}

// ── Start ──

const listenAddress = formatListenAddress(HOST, PORT);

console.log(`🚀 Antigravity 日本語版サーバーを起動中: ${listenAddress}`);
if (webDistDir) {
  console.log(`📦 日本語 Web UI を一体配信します: ${webDistDir}`);
}

const server = createAdaptorServer({ fetch: app.fetch, port: PORT });

setupWebSocket(server, PORT, ALLOWED_ORIGINS);

void discovery
  .getInstances()
  .then((instances) => {
    if (instances.length > 0) {
      console.log(`🔗 Antigravity エンジンを ${instances.length} 件検出しました`);
      return;
    }

    console.warn(
      "⚠️ 起動中の Antigravity エンジンが見つかりません。Antigravity を起動しているか確認してください。",
    );
  })
  .catch((err) => {
    console.warn(`⚠️ 初回検出に失敗しました: ${(err as Error).message}`);
  });

server.listen(PORT, HOST, () => {
  console.log(`✅ Antigravity 日本語版が待機中です: ${listenAddress}`);
});

function gracefulExit() {
  stopStandaloneCore();
  const forceTimer = setTimeout(() => {
    process.exit(0);
  }, 500);
  forceTimer.unref();
  try {
    server.close(() => {
      process.exit(0);
    });
  } catch {
    process.exit(0);
  }
}

process.on("SIGTERM", gracefulExit);
process.on("SIGINT", gracefulExit);
