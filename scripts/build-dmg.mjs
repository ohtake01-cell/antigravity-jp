#!/usr/bin/env node
/**
 * 単体完結版 Antigravity日本語版.app（runtime 内蔵）を作成し、
 * Mac 標準インストーラー (.dmg) と配布用 .zip を生成するスクリプト
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf-8"));
const appVersion = String(pkg.version || "1.5.1").replace(/^v/i, "");
const versionTag = `v${appVersion}`;
const releaseRoot = path.join(rootDir, "dist-release");
const bundleDir = path.join(releaseRoot, "Antigravity日本語版_Mac配布セット");

const srcApp = path.join(bundleDir, "Antigravity日本語版.app");
const srcRuntime = path.join(bundleDir, "runtime");

if (!existsSync(srcApp) || !existsSync(srcRuntime)) {
  throw new Error("先に scripts/build-release-package.mjs を実行してください。");
}

const stageRoot = mkdtempSync(path.join(tmpdir(), "ag-jp-dmg-"));
const dmgStage = path.join(stageRoot, "Antigravity 日本語版");
mkdirSync(dmgStage, { recursive: true });

/**
 * Node.js 公式の darwin-arm64 / darwin-x64 から `bin/node` 単体を取得し、
 * `lipo -create` で Apple Silicon + Intel 両対応の Universal Node バイナリを生成・キャッシュする。
 */
function ensureUniversalNodeBinary() {
  const nodeVer = process.env.AG_JP_NODE_VERSION || process.version; // 例: v24.15.0
  const cacheDir = path.join(tmpdir(), "ag-jp-node-universal-cache", nodeVer);
  const universalBin = path.join(cacheDir, "node-universal");
  if (existsSync(universalBin)) {
    const info = execFileSync("lipo", ["-info", universalBin], { encoding: "utf-8" });
    if (info.includes("arm64") && info.includes("x86_64")) {
      console.log(`♻️ キャッシュ済み Universal Node (${nodeVer}) を使用します`);
      return universalBin;
    }
  }

  mkdirSync(cacheDir, { recursive: true });
  const archBins = {};
  for (const arch of ["arm64", "x64"]) {
    const binOut = path.join(cacheDir, `node-${arch}`);
    if (!existsSync(binOut)) {
      const url = `https://nodejs.org/dist/${nodeVer}/node-${nodeVer}-darwin-${arch}.tar.gz`;
      const tgz = path.join(cacheDir, `node-${nodeVer}-darwin-${arch}.tar.gz`);
      console.log(`⬇️ Node.js ${nodeVer} (${arch}) を取得中...`);
      execFileSync("curl", ["-fSL", "--retry", "3", "-o", tgz, url], { stdio: "inherit" });
      const extractTmp = mkdtempSync(path.join(tmpdir(), `ag-jp-node-${arch}-`));
      try {
        execFileSync(
          "tar",
          ["-xzf", tgz, "-C", extractTmp, `node-${nodeVer}-darwin-${arch}/bin/node`],
          { stdio: "inherit" },
        );
        cpSync(path.join(extractTmp, `node-${nodeVer}-darwin-${arch}`, "bin", "node"), binOut);
        chmodSync(binOut, 0o755);
      } finally {
        rmSync(extractTmp, { recursive: true, force: true });
        rmSync(tgz, { force: true });
      }
    }
    archBins[arch] = binOut;
  }

  console.log(`🧬 Universal Node (${nodeVer}: arm64 + x86_64) を合成中...`);
  execFileSync("lipo", ["-create", archBins.arm64, archBins.x64, "-output", universalBin], {
    stdio: "inherit",
  });
  chmodSync(universalBin, 0o755);
  return universalBin;
}

try {
  // 1. .app をコピーし、Contents/Resources/runtime を内蔵（ドラッグ&ドロップだけで単体起動可能に！）
  const standaloneApp = path.join(dmgStage, "Antigravity日本語版.app");
  execFileSync("ditto", [srcApp, standaloneApp], { stdio: "inherit" });
  const appRuntimeDir = path.join(standaloneApp, "Contents", "Resources", "runtime");
  cpSync(srcRuntime, appRuntimeDir, { recursive: true, dereference: true });

  // 1b. Universal Node.js (arm64 + x86_64) を内蔵し、Apple Silicon / Intel どちらでも Node 未導入で完全動作させる
  const universalNodeSrc = ensureUniversalNodeBinary();
  const appNodeBinDir = path.join(appRuntimeDir, "bin");
  const appNodeBin = path.join(appNodeBinDir, "node");
  mkdirSync(appNodeBinDir, { recursive: true });
  cpSync(universalNodeSrc, appNodeBin);
  chmodSync(appNodeBin, 0o755);

  // 内蔵バイナリ（arm64 + x86_64）の Universal 構成を厳格検証
  for (const [label, binPath] of [
    ["AntigravityJP", path.join(standaloneApp, "Contents", "MacOS", "AntigravityJP")],
    ["runtime/bin/node", appNodeBin],
  ]) {
    const lipoOut = execFileSync("lipo", ["-info", binPath], { encoding: "utf-8" }).trim();
    if (!lipoOut.includes("arm64") || !lipoOut.includes("x86_64")) {
      throw new Error(`${label} が Universal (arm64 + x86_64) ではありません: ${lipoOut}`);
    }
    console.log(`✅ Universal 確認済 (${label}): ${lipoOut}`);
  }

  // 内蔵 node バイナリを先に ad-hoc 署名してから .app 全体を署名（Apple Silicon の厳格な署名チェック対応）
  execFileSync("codesign", ["--force", "--sign", "-", appNodeBin], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", standaloneApp], {
    stdio: "inherit",
  });

  // 2. /Applications へのドラッグ＆ドロップ用リンク＋補助ファイル配置
  symlinkSync("/Applications", path.join(dmgStage, "Applications"));

  for (const name of [
    "セットアップ.command",
    "アンインストール.command",
    "はじめにお読みください.txt",
    "LICENSE.txt",
  ]) {
    const src = path.join(bundleDir, name);
    if (existsSync(src)) {
      const dst = path.join(dmgStage, name);
      cpSync(src, dst);
      if (name.endsWith(".command")) chmodSync(dst, 0o755);
    }
  }

  // 3. プライバシー・個人環境情報ゼロ検査
  const currentUser = userInfo().username;
  const homePath = homedir();
  const forbiddenPatterns = [
    new RegExp(homePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    new RegExp(`/Users/${currentUser.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"),
  ];
  const textExts = new Set([".js", ".mjs", ".json", ".html", ".css", ".txt", ".command", ".plist"]);
  const violations = [];
  function scan(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        scan(full);
      } else if (textExts.has(path.extname(ent.name).toLowerCase())) {
        const txt = readFileSync(full, "utf-8");
        for (const pat of forbiddenPatterns) {
          if (pat.test(txt)) {
            violations.push(`${full} matched ${pat}`);
          }
        }
      }
    }
  }
  scan(dmgStage);
  if (violations.length > 0) {
    throw new Error(`個人情報混入を検出:\n${violations.join("\n")}`);
  }
  console.log("✅ DMG ステージング プライバシー検査: 異常なし (0件)");

  // 4. .dmg 作成（圧縮 UDZO・バージョン入りファイル名）
  const dmgOut = path.join(releaseRoot, `Antigravity-JP-${versionTag}-macOS.dmg`);
  rmSync(dmgOut, { force: true });
  execFileSync(
    "hdiutil",
    [
      "create",
      "-volname",
      `Antigravity 日本語版 ${versionTag}`,
      "-srcfolder",
      dmgStage,
      "-ov",
      "-format",
      "UDZO",
      dmgOut,
    ],
    { stdio: "inherit" },
  );

  // 5. 単体完結 .app 入り .zip も生成（GitHub ダウンロード URL / 自動アップデート用）
  const zipOut = path.join(releaseRoot, `Antigravity-JP-${versionTag}-macOS.zip`);
  rmSync(zipOut, { force: true });
  execFileSync(
    "ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", dmgStage, zipOut],
    { stdio: "inherit" },
  );

  const dmgMb = (statSync(dmgOut).size / 1024 / 1024).toFixed(2);
  const zipMb = (statSync(zipOut).size / 1024 / 1024).toFixed(2);
  console.log(`🎉 DMG 生成完了: ${dmgOut} (${dmgMb} MB)`);
  console.log(`🎉 ZIP 生成完了: ${zipOut} (${zipMb} MB)`);
} finally {
  rmSync(stageRoot, { recursive: true, force: true });
}
