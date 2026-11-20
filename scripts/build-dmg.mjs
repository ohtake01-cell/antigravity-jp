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

try {
  // 1. .app をコピーし、Contents/Resources/runtime を内蔵（ドラッグ&ドロップだけで単体起動可能に！）
  const standaloneApp = path.join(dmgStage, "Antigravity日本語版.app");
  execFileSync("ditto", [srcApp, standaloneApp], { stdio: "inherit" });
  cpSync(
    srcRuntime,
    path.join(standaloneApp, "Contents", "Resources", "runtime"),
    { recursive: true, dereference: true },
  );

  // ad-hoc 署名をし直して macOS Gatekeeper 整合性を保つ
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

  // 4. .dmg 作成（圧縮 UDZO）
  const dmgOut = path.join(releaseRoot, "Antigravity-JP-macOS.dmg");
  rmSync(dmgOut, { force: true });
  execFileSync(
    "hdiutil",
    [
      "create",
      "-volname",
      "Antigravity 日本語版",
      "-srcfolder",
      dmgStage,
      "-ov",
      "-format",
      "UDZO",
      dmgOut,
    ],
    { stdio: "inherit" },
  );

  // 5. 単体完結 .app 入り .zip も生成（GitHub ダウンロード URL 用）
  const zipOut = path.join(releaseRoot, "Antigravity-JP-macOS.zip");
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
