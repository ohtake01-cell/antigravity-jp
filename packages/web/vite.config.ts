import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import { VitePWA } from "vite-plugin-pwa";
import { normalizeBasePath } from "./src/basePath.shared";
import { accessGate } from "./vite-access-gate";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function toHttpOrigin(host: string, port: string) {
  const normalizedHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${normalizedHost}:${port}`;
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const proxyHost = env.PORTA_HOST || process.env.PORTA_HOST || "127.0.0.1";
  const proxyPort = env.PORTA_PORT || process.env.PORTA_PORT || "3470";

  const rawBasePath = env.PORTA_BASE_PATH || process.env.PORTA_BASE_PATH || "/";
  const basePath = normalizeBasePath(rawBasePath);
  const allowedHostsRaw = env.PORTA_ALLOWED_HOSTS || process.env.PORTA_ALLOWED_HOSTS;
  const allowedHostsValue = allowedHostsRaw?.trim();
  const allowedHosts = allowedHostsValue === "true" || allowedHostsValue === "all" || allowedHostsValue === "*"
    ? true
    : (allowedHostsValue
      ? allowedHostsValue.split(",").map((host) => host.trim()).filter(Boolean)
      : undefined);

  // Access gate: when PORTA_REQUIRE_AUTH is set, every request (page, /api, WebSocket)
  // must carry a valid PORTA_ACCESS_TOKEN. Essential when the dev server is exposed
  // publicly via a tunnel. Fail-closed: enabled but no token => everything denied.
  const requireAuthRaw = (
    env.PORTA_REQUIRE_AUTH || process.env.PORTA_REQUIRE_AUTH || ""
  ).trim();
  const requireAuth = /^(1|true|yes|on)$/i.test(requireAuthRaw);
  if (
    requireAuthRaw &&
    !requireAuth &&
    !/^(0|false|no|off)$/i.test(requireAuthRaw)
  ) {
    throw new Error(
      "PORTA_REQUIRE_AUTH must be one of 1/true/yes/on or 0/false/no/off.",
    );
  }
  const accessToken = env.PORTA_ACCESS_TOKEN || process.env.PORTA_ACCESS_TOKEN || "";

  return {
    base: basePath,
    define: {
      "import.meta.env.PORTA_BASE_PATH": JSON.stringify(basePath),
    },
    plugins: [
      // Must be first so it gates requests before any other middleware.
      accessGate({ enabled: requireAuth, token: accessToken }),
      react(),
      VitePWA({
        // Vite 8 + Node 24 環境での workbox closeBundle ハングを回避（manifest.json による PWA 導入は常時有効）
        disable: (env.PORTA_ENABLE_WORKBOX || process.env.PORTA_ENABLE_WORKBOX) !== "1",
        registerType: "autoUpdate",
        workbox: {
          // Only precache hashed static assets — NOT index.html.
          // index.html must always come from the network so deploys
          // take effect immediately. Hashed filenames (e.g. index-Ab12Cd.js)
          // guarantee the SW cache entry matches the code version.
          globPatterns: ["**/*.{js,css,ico,png,svg,woff2}"],
          skipWaiting: true,
          clientsClaim: true,
          // Don't create a NavigationRoute — let navigation requests
          // hit the network (Cloudflare CDN) for a fresh index.html.
          navigateFallback: null,
        },
        manifest: false, // Use our existing public/manifest.json
        injectRegister: "script-defer",
        scope: basePath,
      }),
    ],
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: "vendor-react",
                test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
                priority: 20,
              },
              {
                name: "vendor-markdown",
                test: /node_modules[\\/]marked[\\/]/,
                priority: 15,
              },
            ],
          },
        },
      },
    },
    envDir: repoRoot,
    server: {
      host: env.PORTA_HOST || process.env.PORTA_HOST || "127.0.0.1",
      port: Number(env.PORTA_WEB_PORT || process.env.PORTA_WEB_PORT || 3471),
      // A tunnel and its watchdog target one fixed origin port. Do not silently
      // move Vite to the next port if that origin is already occupied.
      strictPort: true,
      ...(allowedHosts !== undefined ? { allowedHosts } : {}),
      proxy: {
        "/api": {
          target: toHttpOrigin(proxyHost, proxyPort),
          changeOrigin: true,
          ws: true,
          headers: {
            ...(env.CF_ACCESS_CLIENT_ID ? { "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID } : {}),
            ...(env.CF_ACCESS_CLIENT_SECRET ? { "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET } : {}),
          },
        },
      },
    },
    preview: {
      host: env.PORTA_HOST || process.env.PORTA_HOST || "127.0.0.1",
      port: Number(env.PORTA_WEB_PORT || process.env.PORTA_WEB_PORT || 5173),
      strictPort: true,
      ...(allowedHosts !== undefined ? { allowedHosts } : {}),
    },
  };
});
