#!/usr/bin/env node
/**
 * 友達にそのまま渡せる Mac 配布セット（フォルダ + .zip）生成スクリプト
 *
 * 出力:
 *   dist-release/Antigravity日本語版_Mac配布セット/
 *   dist-release/Antigravity日本語版_Mac配布セット.zip
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const releaseRoot = path.join(rootDir, "dist-release");
const bundleName = "Antigravity日本語版_Mac配布セット";
const bundleDir = path.join(releaseRoot, bundleName);
const zipPath = path.join(releaseRoot, `${bundleName}.zip`);

const macAppSrc = path.join(rootDir, "dist-macos", "Antigravity日本語版.app");
const proxyDistSrc = path.join(rootDir, "packages", "proxy", "dist");
const webDistSrc = path.join(rootDir, "packages", "web", "dist");

for (const [label, p] of [
  ["Mac .app", macAppSrc],
  ["proxy dist", proxyDistSrc],
  ["web dist", webDistSrc],
]) {
  if (!existsSync(p)) {
    throw new Error(`${label} が見つかりません: ${p}`);
  }
}

// 1. 出力先クリーン初期化
rmSync(bundleDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(bundleDir, { recursive: true });

// 2. Mac .app 本体コピー（ditto で署名・実行権限・リソースを完全保持）
execFileSync("ditto", [macAppSrc, path.join(bundleDir, "Antigravity日本語版.app")], {
  stdio: "inherit",
});

// 3. runtime/ 構築（Node.js さえあれば npm install 不要で即動く純JSランタイム）
const runtimeDir = path.join(bundleDir, "runtime");
mkdirSync(path.join(runtimeDir, "proxy"), { recursive: true });
mkdirSync(path.join(runtimeDir, "web"), { recursive: true });

cpSync(proxyDistSrc, path.join(runtimeDir, "proxy", "dist"), { recursive: true });
cpSync(webDistSrc, path.join(runtimeDir, "web", "dist"), { recursive: true });

// runtime/proxy/package.json（ESM "type": "module" 維持用）
const proxyPkg = JSON.parse(
  readFileSync(path.join(rootDir, "packages", "proxy", "package.json"), "utf-8"),
);
writeFileSync(
  path.join(runtimeDir, "proxy", "package.json"),
  JSON.stringify(
    {
      name: "antigravity-jp-proxy",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: proxyPkg.dependencies,
    },
    null,
    2,
  ) + "\n",
  "utf-8",
);

// 本番実行に必要な依存パッケージ（hono, @hono/node-server, ws）を実体コピー（symlink 解除）
const proxyNodeModules = path.join(rootDir, "packages", "proxy", "node_modules");
const runtimeNodeModules = path.join(runtimeDir, "proxy", "node_modules");
mkdirSync(runtimeNodeModules, { recursive: true });

for (const depName of Object.keys(proxyPkg.dependencies ?? {})) {
  const srcDep = path.join(proxyNodeModules, ...depName.split("/"));
  const destDep = path.join(runtimeNodeModules, ...depName.split("/"));
  if (!existsSync(srcDep)) {
    throw new Error(`実行依存パッケージが見つかりません: ${srcDep}`);
  }
  mkdirSync(path.dirname(destDep), { recursive: true });
  cpSync(srcDep, destDep, { recursive: true, dereference: true });
}

// 4. セットアップ / アンインストール / はじめにお読みください / ライセンス配置
const setupDest = path.join(bundleDir, "セットアップ.command");
const uninstallDest = path.join(bundleDir, "アンインストール.command");
cpSync(path.join(rootDir, "deploy", "macos", "setup.command"), setupDest);
cpSync(path.join(rootDir, "deploy", "macos", "uninstall.command"), uninstallDest);
chmodSync(setupDest, 0o755);
chmodSync(uninstallDest, 0o755);

cpSync(
  path.join(rootDir, "deploy", "macos", "README_友達向け.txt"),
  path.join(bundleDir, "はじめにお読みください.txt"),
);
if (existsSync(path.join(rootDir, "LICENSE"))) {
  cpSync(path.join(rootDir, "LICENSE"), path.join(bundleDir, "LICENSE.txt"));
}

// 5. クリーンなソースコード一式も source/ へ同梱（再ビルド・改造したい人向け）
const sourceDest = path.join(bundleDir, "source");
mkdirSync(sourceDest, { recursive: true });
const copyItems = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  ".env.example",
  "LICENSE",
  "README.md",
  "AI_CUSTOMIZE_GUIDE.md",
  "deploy",
  "scripts",
  "packages",
];

const IGNORE_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  ".env",
  "logs",
  "dist-macos",
  "dist-release",
  ".DS_Store",
]);

for (const item of copyItems) {
  const src = path.join(rootDir, item);
  if (!existsSync(src)) continue;
  cpSync(src, path.join(sourceDest, item), {
    recursive: true,
    filter: (p) => !IGNORE_NAMES.has(path.basename(p)),
  });
}

// 6. プライバシー・ビルド環境情報の混入ゼロ検査（動的検出・スクリプト内ハードコードなし）
const currentUser = userInfo().username;
const currentHome = homedir();
const FORBIDDEN_REGEXES = [
  new RegExp(currentHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  ...(currentUser.length >= 4
    ? [new RegExp(currentUser.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))]
    : []),
  /\btail[a-z0-9-]+\.ts\.net\b/i,
  /\/Volumes\/AI\b/,
];

function scanForLeaks(dir) {
  const leaks = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      leaks.push(...scanForLeaks(full));
      continue;
    }
    if (st.size > 2 * 1024 * 1024) continue;
    const ext = path.extname(full).toLowerCase();
    if ([".png", ".jpg", ".icns", ".ico", ".woff2", ".zip"].includes(ext)) continue;
    const buf = readFileSync(full);
    if (buf.includes(0)) continue; // バイナリ除外
    const text = buf.toString("utf-8");
    for (const re of FORBIDDEN_REGEXES) {
      if (re.test(text)) {
        leaks.push(`${re} -> ${path.relative(bundleDir, full)}`);
      }
    }
  }
  return leaks;
}

const leaks = scanForLeaks(bundleDir);
if (leaks.length > 0) {
  throw new Error(`配布物に個人環境情報が混入しています:\n${leaks.join("\n")}`);
}
console.log("✅ プライバシー・個人環境情報ゼロ検査: 異常なし (0件)");

// 7. macOS 標準 ditto で配布 ZIP 作成（実行権限・日本語ファイル名・リソース完全保持）
execFileSync(
  "ditto",
  ["-c", "-k", "--sequesterRsrc", "--keepParent", bundleDir, zipPath],
  { stdio: "inherit" },
);

const zipSizeMb = (statSync(zipPath).size / (1024 * 1024)).toFixed(2);
console.log(`🎉 配布パッケージ生成完了: ${zipPath} (${zipSizeMb} MB)`);
