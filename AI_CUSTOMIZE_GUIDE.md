# AI エージェント向け カスタマイズ＆ビルドガイド（Antigravity 日本語版）

このドキュメントは、ユーザーが **自分の AI エージェント（Antigravity / Gemini / Claude / Codex など）** にこのアプリのUIや機能を改造してもらうための引き継ぎ仕様書です。

---

## 1. 全体構成（モノレポ）

```text
.
├── packages/
│   ├── proxy/          # ローカル HTTP/WebSocket ブリッジ (Hono + TypeScript, 既定ポート 3470)
│   │   └── src/
│   │       ├── index.ts              # サーバー起動・ルート登録・静的配信
│   │       ├── discovery.ts          # Antigravity Language Server 自動検出・健全性ランク付け
│   │       ├── routing.ts            # 会話アフィニティ・LS RPC 振り分け
│   │       ├── rpc.ts                # LS 向け HTTP/HTTPS JSON-RPC クライアント
│   │       ├── metadata.ts           # 会話/プロジェクト/サブエージェント/モデル推定
│   │       ├── title-formatter.ts    # チャットタイトルの自動日本語整形
│   │       ├── ws.ts                 # ステップのリアルタイム WebSocket 配信
│   │       └── routes/
│   │           ├── conversations.ts  # 会話一覧・送信・停止・権限応答・リバート
│   │           ├── models.ts         # モデル一覧・クォータ取得
│   │           ├── usage.ts          # 直近7日間のローカル .pb トークン集計
│   │           ├── voice.ts          # 音声文字起こし
│   │           ├── files.ts          # 右ペイン用の安全なファイル読み書き・アップロード
│   │           ├── jpRule.ts         # ~/.gemini/GEMINI.md の日本語ルール設定 API
│   │           ├── permissions.ts    # LS 権限プリセット取得/更新
│   │           └── providers.ts      # 他社AI検出・公式CLIログイン起動・マルチAIセッション API
│   └── web/            # フロントエンド UI (React 19 + Vite + TypeScript)
│       └── src/
│           ├── App.tsx               # メインレイアウト・下位/上位モードルーティング・枝分かれ
│           ├── api/client.ts         # Proxy API クライアント
│           ├── components/
│           │   ├── Sidebar.tsx            # サイドバー（1本スクロール・ピン留め・子チャット階層・上位時のみ⚡マルチAI）
│           │   ├── ChatHeader.tsx         # ヘッダー（⌘K・エディタ・クォータ残量バー・接続先）
│           │   ├── ChatPanel.tsx          # チャット本文・インライン編集・思考/ツール折りたたみ
│           │   ├── MultiAIPanel.tsx       # 上位モード用マルチAIハブ（OpenAI / Claude / Ollama 対話＆ログイン連携）
│           │   ├── ChatInput.tsx          # 入力欄・モデル選択・Local Permissions・音声・添付
│           │   ├── TokenQuotaBadge.tsx    # コンテキスト重み・残り枠バッジ
│           │   ├── WeeklyUsageBadge.tsx   # 週間トークン消費＆残り枠ポップオーバー
│           │   ├── AgentMonitorPanel.tsx  # 右ペイン：サブエージェント・タスク監視
│           │   ├── ArtifactWorkbench.tsx  # 右ペイン：Markdown/Mermaid/画像/PDF ビューア
│           │   ├── CommandPalette.tsx     # ⌘K コマンドパレット
│           │   └── SettingsPanel.tsx      # 設定画面（日本語固定・モデル・アーカイブ復元）
│           └── styles/               # CSS（テーマ変数・チャット・サイドバー・入力欄など）
├── deploy/macos/
│   └── AntigravityJPApp.swift        # macOS ネイティブアプリ本体 (Swift + WKWebView)
└── scripts/
    ├── build-macos-app.mjs           # Universal Binary (.app) ビルド
    ├── build-release-package.mjs     # 配布フォルダ＆PIIチェック
    └── build-dmg.mjs                 # runtime 同梱スタンドアロン .app / .dmg / .zip 生成
```

---

## 2. 開発・テスト・再ビルドコマンド

### 初回セットアップ
```bash
pnpm install
# pnpm がない場合:
# (cd packages/proxy && npm install) && (cd packages/web && npm install)
```

### 型チェック ＆ ビルド
```bash
# Proxy ビルド
cd packages/proxy && ./node_modules/.bin/tsc -p tsconfig.json

# Web 型チェック ＆ ビルド
cd packages/web && ./node_modules/.bin/tsc --noEmit && node node_modules/vite/bin/vite.js build
```

### テスト実行
```bash
cd packages/proxy && ./node_modules/.bin/vitest run --maxWorkers=1
cd packages/web && ./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism
```

### macOS アプリ（`.app` / `.dmg` / `.zip`）を再生成して `/Applications` に反映
```bash
# 1. Proxy & Web をビルド済みにしてから実行
node scripts/build-release-package.mjs
node scripts/build-dmg.mjs

# 2. Swift 側 (deploy/macos/AntigravityJPApp.swift) を変更した場合のみ先に実行:
node scripts/build-macos-app.mjs
```
生成先: `dist-release/Antigravity-JP-macOS.dmg`（および `.zip`）

---

## 3. 改造時の重要な技術ルール（ハマりやすい点）

1. **既定ポートは `3470`**（`127.0.0.1:3470`）。本家アプリや他のローカル開発サーバーと衝突しない設計です。
2. **Vite PWA プラグイン**: Node 24 環境で `VitePWA` がビルドハングするのを防ぐため、`packages/web/vite.config.ts` では `PORTA_ENABLE_PWA=1` 指定時のみ有効になっています。変更しないでください。
3. **複数 Language Server へのルーティング**:
   - `~/.gemini/antigravity/daemon/*.json` にモデル数 0 の未認証ハブと、正常なメイン LS が並存することがあります。
   - `packages/proxy/src/discovery.ts` の `sortInstancesByHealth`（`modelCount > 0` を優先）を壊さないようにしてください。
4. **Antigravity LS の主要 Protobuf フィールド**:
   - `SendUserCascadeMessage` の自動実行ポリシー:
     `cascadeConfig.plannerConfig.toolConfig.runCommand.autoCommandConfig.autoExecutionPolicy`
     値: `CASCADE_COMMANDS_AUTO_EXECUTION_{OFF,PROCEED_IN_SANDBOX,AUTO,EAGER}`
   - エラーステップ (`CORTEX_STEP_TYPE_ERROR_MESSAGE`):
     `step.errorMessage.error.{userErrorMessage, shortError, fullError, errorCode}`
5. **macOS ネイティブアプリとの連携イベント**:
   - Swift (`AntigravityJPApp.swift`) → Web:
     - `antigravity-jp:new-chat`（メニュー「新しいチャット」/ ⌘N）
     - `antigravity-jp:open-settings`（メニュー「設定…」/ ⌘,）
     - `antigravity-jp:insert-paths`（非画像ファイルのドラッグ＆ドロップ）
   - Web → Swift: `window.webkit?.messageHandlers?.agJpNative?.postMessage({ type: "copy" | "notify", ... })`

---

## 4. よくあるカスタマイズ例

- **テーマ・配色変更**: `packages/web/src/styles/variables.css` の CSS 変数を編集
- **日本語ルールの文言変更**: `packages/proxy/src/routes/jpRule.ts` のテンプレート文字列を編集
- **サイドバーの表示件数・並び順変更**: `packages/web/src/components/Sidebar.tsx` を編集
- **チャット送信時の既定モデル・権限・下位/上位モード既定値**: `packages/web/src/hooks/useClientSettings.ts`（`appTier: "lite" | "pro"`）を編集
- **他社AIプロバイダー連携のカスタマイズ**: `packages/proxy/src/routes/providers.ts` と `packages/web/src/components/MultiAIPanel.tsx` を編集
- **ローカル専用拡張（個人環境を外出しする口）**: `~/.config/antigravity-jp/extensions.json` に `{ "extensions": [...] }` を置くと `GET /api/providers` から自動で読み込まれます（リポジトリへ個人情報を混ぜずに独自拡張を追加可能）
