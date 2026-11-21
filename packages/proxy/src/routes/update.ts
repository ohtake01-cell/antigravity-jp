/**
 * アップデート確認ルート（GitHub Releases 連携）
 *
 * macOS ネイティブアプリ外（通常ブラウザ表示時）や設定画面の初期表示でも
 * 現在のバージョンと最新リリース情報を確認できるようにする。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";

export const UPDATE_REPO_OWNER = "ohtake01-cell";
export const UPDATE_REPO_NAME = "antigravity-jp";
export const UPDATE_RELEASES_PAGE_URL = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases`;
export const UPDATE_API_LATEST_URL = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/latest`;
export const UPDATE_WEB_LATEST_URL = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/latest`;

export interface ReleaseAssetInfo {
  name: string;
  downloadUrl: string;
  size: number;
  sha256: string | null;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseUrl: string;
  publishedAt: string | null;
  zipAsset: ReleaseAssetInfo | null;
  dmgAsset: ReleaseAssetInfo | null;
  checkedAt: string;
  source: "github-api" | "github-redirect" | "error";
  error?: string;
}

interface GitHubApiAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
  digest?: string | null;
}

interface GitHubApiRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  assets?: GitHubApiAsset[];
}

/** 先頭の "v" やプレリリースサフィックスを取り除き [major, minor, patch] に正規化 */
export function parseSemver(raw: string): [number, number, number] {
  const cleaned = raw.trim().replace(/^v/i, "").split("-")[0] ?? "";
  const parts = cleaned.split(".").map((n) => {
    const parsed = Number.parseInt(n, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** a > b なら 1、a < b なら -1、等しければ 0 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export function normalizeVersionString(raw: string): string {
  const trimmed = raw.trim().replace(/^v/i, "");
  return trimmed || "0.0.0";
}

function extractSha256(digest?: string | null): string | null {
  if (!digest || typeof digest !== "string") return null;
  const m = digest.trim().match(/^sha256:([0-9a-fA-F]{64})$/);
  return m ? m[1].toLowerCase() : null;
}

export function resolveCurrentAppVersion(): string {
  const envVersion = process.env.AG_JP_APP_VERSION?.trim();
  if (envVersion) return normalizeVersionString(envVersion);

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../../../package.json"),
    resolve(here, "../../../package.json"),
    resolve(here, "../../package.json"),
    join(process.cwd(), "package.json"),
  ];
  for (const pkgPath of candidates) {
    if (!existsSync(pkgPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === "antigravity-jp" && typeof parsed.version === "string") {
        return normalizeVersionString(parsed.version);
      }
    } catch {
      // 次の候補を確認
    }
  }
  return "1.5.4";
}

export function parseGitHubReleasePayload(
  payload: GitHubApiRelease,
  currentVersion: string,
): UpdateCheckResult {
  const latestVersion = payload.tag_name
    ? normalizeVersionString(payload.tag_name)
    : null;
  const assets = Array.isArray(payload.assets) ? payload.assets : [];

  const toAssetInfo = (a: GitHubApiAsset | undefined): ReleaseAssetInfo | null => {
    if (!a?.name || !a.browser_download_url) return null;
    return {
      name: a.name,
      downloadUrl: a.browser_download_url,
      size: typeof a.size === "number" ? a.size : 0,
      sha256: extractSha256(a.digest),
    };
  };

  const zipAsset = toAssetInfo(
    assets.find(
      (a) =>
        a.name === "Antigravity-JP-macOS.zip" ||
        (a.name?.endsWith(".zip") && a.name.toLowerCase().includes("macos")),
    ),
  );
  const dmgAsset = toAssetInfo(
    assets.find(
      (a) =>
        a.name === "Antigravity-JP-macOS.dmg" || a.name?.endsWith(".dmg"),
    ),
  );

  const updateAvailable = Boolean(
    latestVersion && compareSemver(latestVersion, currentVersion) > 0,
  );

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseName: payload.name ?? (latestVersion ? `v${latestVersion}` : null),
    releaseNotes: payload.body ?? null,
    releaseUrl: payload.html_url || UPDATE_RELEASES_PAGE_URL,
    publishedAt: payload.published_at ?? null,
    zipAsset,
    dmgAsset,
    checkedAt: new Date().toISOString(),
    source: "github-api",
  };
}

export function buildRedirectFallbackResult(
  redirectedUrl: string,
  currentVersion: string,
): UpdateCheckResult | null {
  const match = redirectedUrl.match(/\/releases\/tag\/(v?[^/?#]+)/i);
  if (!match) return null;
  const tag = match[1];
  const latestVersion = normalizeVersionString(tag);
  const tagWithV = tag.startsWith("v") || tag.startsWith("V") ? tag : `v${latestVersion}`;
  const zipName = `Antigravity-JP-${tagWithV}-macOS.zip`;
  const dmgName = `Antigravity-JP-${tagWithV}-macOS.dmg`;
  const baseDownload = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/download/${encodeURIComponent(tag)}`;
  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
    releaseName: `Antigravity 日本語版 v${latestVersion}`,
    releaseNotes: null,
    releaseUrl: redirectedUrl,
    publishedAt: null,
    zipAsset: {
      name: zipName,
      downloadUrl: `${baseDownload}/${zipName}`,
      size: 0,
      sha256: null,
    },
    dmgAsset: {
      name: dmgName,
      downloadUrl: `${baseDownload}/${dmgName}`,
      size: 0,
      sha256: null,
    },
    checkedAt: new Date().toISOString(),
    source: "github-redirect",
  };
}

const CACHE_TTL_MS = 5 * 60_000;
let cachedResult: { data: UpdateCheckResult; fetchedAt: number } | null = null;

export async function checkLatestRelease(
  force = false,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateCheckResult> {
  const currentVersion = resolveCurrentAppVersion();
  const now = Date.now();
  if (!force && cachedResult && now - cachedResult.fetchedAt < CACHE_TTL_MS) {
    return {
      ...cachedResult.data,
      currentVersion,
      updateAvailable: Boolean(
        cachedResult.data.latestVersion &&
          compareSemver(cachedResult.data.latestVersion, currentVersion) > 0,
      ),
    };
  }

  const apiUrl = process.env.AG_JP_UPDATE_API_URL || UPDATE_API_LATEST_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetchImpl(apiUrl, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Antigravity-JP/${currentVersion}`,
      },
    });
    if (res.ok) {
      const payload = (await res.json()) as GitHubApiRelease;
      const result = parseGitHubReleasePayload(payload, currentVersion);
      cachedResult = { data: result, fetchedAt: now };
      return result;
    }

    // API レート制限 (403/429) 時は Web の /releases/latest リダイレクトからタグ取得へフォールバック
    if (res.status === 403 || res.status === 429) {
      const fallbackRes = await fetchImpl(UPDATE_WEB_LATEST_URL, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": `Antigravity-JP/${currentVersion}` },
      });
      const fallback = buildRedirectFallbackResult(
        fallbackRes.url,
        currentVersion,
      );
      if (fallback) {
        cachedResult = { data: fallback, fetchedAt: now };
        return fallback;
      }
    }

    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseName: null,
      releaseNotes: null,
      releaseUrl: UPDATE_RELEASES_PAGE_URL,
      publishedAt: null,
      zipAsset: null,
      dmgAsset: null,
      checkedAt: new Date().toISOString(),
      source: "error",
      error: `GitHub Releases の取得に失敗しました (HTTP ${res.status})`,
    };
  } catch (err) {
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseName: null,
      releaseNotes: null,
      releaseUrl: UPDATE_RELEASES_PAGE_URL,
      publishedAt: null,
      zipAsset: null,
      dmgAsset: null,
      checkedAt: new Date().toISOString(),
      source: "error",
      error:
        err instanceof Error
          ? err.message
          : "アップデート確認中にネットワークエラーが発生しました",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function registerUpdateRoutes(app: Hono): void {
  app.get("/api/update/check", async (c) => {
    const force = c.req.query("force") === "1" || c.req.query("force") === "true";
    const result = await checkLatestRelease(force);
    return c.json(result);
  });
}
