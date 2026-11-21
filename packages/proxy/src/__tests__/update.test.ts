import { describe, it, expect, vi } from "vitest";
import {
  compareSemver,
  parseGitHubReleasePayload,
  buildRedirectFallbackResult,
  checkLatestRelease,
} from "../routes/update.js";

describe("update route helpers", () => {
  it("compares semantic versions numerically (including multi-digit minor/patch)", () => {
    expect(compareSemver("1.5.0", "1.4.0")).toBe(1);
    expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
    expect(compareSemver("v1.5.0", "1.5.0")).toBe(0);
    expect(compareSemver("1.4.0", "1.5.0")).toBe(-1);
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
  });

  it("parses GitHub release payload including zip/dmg assets and sha256 digest", () => {
    const sha = "a".repeat(64);
    const result = parseGitHubReleasePayload(
      {
        tag_name: "v1.6.0",
        name: "Antigravity 日本語版 v1.6.0",
        body: "- 自動アップデート対応",
        html_url: "https://github.com/ohtake01-cell/antigravity-jp/releases/tag/v1.6.0",
        published_at: "2026-11-21T05:00:00Z",
        assets: [
          {
            name: "Antigravity-JP-macOS.zip",
            browser_download_url: "https://example.com/Antigravity-JP-macOS.zip",
            size: 80_000_000,
            digest: `sha256:${sha}`,
          },
          {
            name: "Antigravity-JP-macOS.dmg",
            browser_download_url: "https://example.com/Antigravity-JP-macOS.dmg",
            size: 95_000_000,
          },
        ],
      },
      "1.5.0",
    );

    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe("1.6.0");
    expect(result.zipAsset?.sha256).toBe(sha);
    expect(result.dmgAsset?.name).toBe("Antigravity-JP-macOS.dmg");
  });

  it("builds fallback metadata from GitHub /releases/latest redirect URL", () => {
    const fallback = buildRedirectFallbackResult(
      "https://github.com/ohtake01-cell/antigravity-jp/releases/tag/v1.7.2",
      "1.5.0",
    );
    expect(fallback).not.toBeNull();
    expect(fallback?.updateAvailable).toBe(true);
    expect(fallback?.latestVersion).toBe("1.7.2");
    expect(fallback?.zipAsset?.downloadUrl).toContain(
      "/releases/download/v1.7.2/Antigravity-JP-macOS.zip",
    );
  });

  it("falls back to redirect when GitHub API returns 403 rate limit", async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 403 }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: "https://github.com/ohtake01-cell/antigravity-jp/releases/tag/v2.0.0",
      } as Response);

    const prevVer = process.env.AG_JP_APP_VERSION;
    process.env.AG_JP_APP_VERSION = "1.5.0";
    try {
      const res = await checkLatestRelease(true, mockFetch);
      expect(res.source).toBe("github-redirect");
      expect(res.updateAvailable).toBe(true);
      expect(res.latestVersion).toBe("2.0.0");
    } finally {
      if (prevVer === undefined) delete process.env.AG_JP_APP_VERSION;
      else process.env.AG_JP_APP_VERSION = prevVer;
    }
  });
});
