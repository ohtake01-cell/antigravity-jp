#!/usr/bin/env node
/**
 * Mac ネイティブアプリ「Antigravity日本語版.app」ビルドスクリプト
 * - Swift + WKWebView（Electron 不使用・約100KB）
 * - 可能なら Universal Binary (arm64 + x86_64) で生成し、Intel / Apple Silicon 両対応にする
 * - 512px/1024px PNG から macOS AppIcon.icns を自動生成
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const swiftSrc = path.join(rootDir, "deploy", "macos", "AntigravityJPApp.swift");
const icon1024 = path.join(rootDir, "packages", "web", "public", "icons", "icon-1024.png");
const icon512 = path.join(rootDir, "packages", "web", "public", "icons", "icon-512.png");
const srcIcon = existsSync(icon1024) ? icon1024 : icon512;

const outApp =
  process.env.AG_JP_MAC_APP_PATH ||
  path.join(rootDir, "dist-macos", "Antigravity日本語版.app");

const contentsDir = path.join(outApp, "Contents");
const macosDir = path.join(contentsDir, "MacOS");
const resourcesDir = path.join(contentsDir, "Resources");

const workTmp = mkdtempSync(path.join(tmpdir(), "ag-jp-macapp-"));

function compileArch(targetTriple, outputBin) {
  execFileSync(
    "/usr/bin/swiftc",
    [
      "-O",
      "-parse-as-library",
      "-target",
      targetTriple,
      swiftSrc,
      "-framework",
      "Cocoa",
      "-framework",
      "WebKit",
      "-framework",
      "IOKit",
      "-framework",
      "UserNotifications",
      "-o",
      outputBin,
    ],
    { stdio: "pipe" },
  );
}

try {
  if (existsSync(outApp)) {
    rmSync(outApp, { recursive: true, force: true });
  }
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });

  // 1. AppIcon.icns 生成
  if (existsSync(srcIcon)) {
    const iconsetDir = path.join(workTmp, "AppIcon.iconset");
    mkdirSync(iconsetDir, { recursive: true });
    const sizes = [
      [16, "icon_16x16.png"],
      [32, "icon_16x16@2x.png"],
      [32, "icon_32x32.png"],
      [64, "icon_32x32@2x.png"],
      [128, "icon_128x128.png"],
      [256, "icon_128x128@2x.png"],
      [256, "icon_256x256.png"],
      [512, "icon_256x256@2x.png"],
      [512, "icon_512x512.png"],
      [1024, "icon_512x512@2x.png"],
    ];
    for (const [px, filename] of sizes) {
      execFileSync(
        "sips",
        ["-z", String(px), String(px), srcIcon, "--out", path.join(iconsetDir, filename)],
        { stdio: "ignore" },
      );
    }
    execFileSync(
      "iconutil",
      ["-c", "icns", iconsetDir, "-o", path.join(resourcesDir, "AppIcon.icns")],
      { stdio: "inherit" },
    );
  }

  // 2. Info.plist 出力（package.json のバージョンを自動反映）
  const pkgVersion = (() => {
    try {
      const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf-8"));
      return typeof pkg.version === "string" && pkg.version ? pkg.version : "1.4.0";
    } catch {
      return "1.4.0";
    }
  })();
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>ja</string>
  <key>CFBundleDisplayName</key>
  <string>Antigravity 日本語版</string>
  <key>CFBundleExecutable</key>
  <string>AntigravityJP</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>jp.antigravity.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Antigravity 日本語版</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${pkgVersion}</string>
  <key>CFBundleVersion</key>
  <string>${pkgVersion}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Antigravity 日本語版の音声入力・音声ライブ対話機能でマイクを使用します。</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>Antigravity 日本語版の音声入力機能で音声認識を使用します。</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
`;
  writeFileSync(path.join(contentsDir, "Info.plist"), infoPlist, "utf-8");

  // 3. Swift バイナリビルド（Universal Binary を優先試行）
  const outBin = path.join(macosDir, "AntigravityJP");
  const armBin = path.join(workTmp, "AntigravityJP_arm64");
  const x64Bin = path.join(workTmp, "AntigravityJP_x86_64");

  console.log("🔨 Antigravity日本語版.app をビルド中...");
  let builtUniversal = false;
  try {
    compileArch("arm64-apple-macosx13.0", armBin);
    compileArch("x86_64-apple-macosx13.0", x64Bin);
    execFileSync("lipo", ["-create", armBin, x64Bin, "-output", outBin], {
      stdio: "inherit",
    });
    builtUniversal = true;
    console.log("✅ Universal Binary (Apple Silicon + Intel) でビルド完了！");
  } catch (universalErr) {
    console.warn("⚠️ Universal ビルドをフォールバックし、この Mac 用単体バイナリでビルドします...");
    execFileSync(
      "/usr/bin/swiftc",
      [
        "-O",
        "-parse-as-library",
        swiftSrc,
        "-framework",
        "Cocoa",
        "-framework",
        "WebKit",
        "-framework",
        "IOKit",
        "-framework",
        "UserNotifications",
        "-o",
        outBin,
      ],
      { stdio: "inherit" },
    );
  }

  // 4. アドホック署名
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", outApp], {
    stdio: "inherit",
  });

  console.log(`🎉 完了: ${outApp} (${builtUniversal ? "Universal" : process.arch})`);
} finally {
  rmSync(workTmp, { recursive: true, force: true });
}
