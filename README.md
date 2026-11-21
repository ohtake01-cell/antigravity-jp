# Antigravity 日本語版（統合エディション：下位 Gemini専用 ⇄ 上位 マルチAI）

Mac 上のローカル [Antigravity](https://antigravity.google/)（Language Server）に接続して使う、**日本語ネイティブのチャット＆マルチAI UI（macOS アプリ + モバイル対応 Web UI）**です。

> 本アプリは MIT ライセンスの [Porta](https://github.com/L1M80/porta) をベースに、日本語チャット体験・設定画面での **「シンプル版（下位・Gemini専用）⇄ マルチAI版（上位・他社AI＆各社公式ログイン連携）」** 切替・コンテキスト重み表示・サブエージェント階層表示・コメントインライン編集・macOS ネイティブアプリ化を行った統合版です。

## 主な機能

- **表示モード切替（設定画面でワンクリック）**:
  - **🌿 シンプル版（下位・既定）**: Gemini（Antigravity）のみをスッキリ表示
  - **⚡ マルチAI版（上位）**: OpenAI（ChatGPT / Codex CLI）・Anthropic（Claude Code CLI）・ローカル Ollama を各社公式ブラウザログインで追加して利用可能（追加 API 課金不要・お手持ちのサブスク枠で動作）
- **完全日本語 UI ＆ 日本語応答ルールワンクリック設定**（`~/.gemini/GEMINI.md`）
- **AI の重み・枠の見える化**: 残りクォータ率・コンテキスト使用量バッジ・7日間のトークン推移
- **整理されたチャット一覧 ＆ スマホ対応**: 1本スクロールサイドバー・ピン留め・実行中グロー表示・プロジェクト別グループ・**親チャット配下への子チャット（サブエージェント）ツリー収納**・自動日本語タイトル化
- **コメントのインライン編集 ＆ 枝分かれチャット（🌿）**: 自分の発言をその場で修正して再送信、本流を汚さずに別チャットや他社AIへ仮説検証を分岐
- **右ペイン・アーティファクトビューア ＆ ⌘K コマンドパレット**: Markdown / Mermaid 図 / CSV / 画像 / PDF プレビュー、音声入力、ファイル D&D
- **🧩 メモリ・MCP・スキル・プラグイン・共通ルール管理**: 設定画面から JSON 手書きなしで外部ツール（MCP）・作業手順（`SKILL.md`）・プラグイン・パーソナルメモリ（`GEMINI.md` 自動同期）を管理
- **📁 プロジェクト専用指示 ＆ ⚡ スラッシュコマンド（`/`）＆ 📤 Markdown エクスポート**: プロジェクト別ルール設定、入力欄の `/要約`・`/翻訳`・`/レビュー`＋自作プロンプト保存、会話の `.md` 書き出し
- **🔄 ワンクリック自動アップデート**: GitHub Releases から最新版を確認し、署名・SHA-256 検証付きで安全に入れ替え＆自動再起動（2回目以降は macOS 警告も不要）

## かんたんインストール（macOS）

1. [Releases ページ](https://github.com/ohtake01-cell/antigravity-jp/releases/latest) から `Antigravity-JP-macOS.dmg` をダウンロード
2. `.dmg` を開き、`Antigravity日本語版.app` を `Applications` フォルダへドラッグ＆ドロップ
3. 本家の **Antigravity** アプリを起動した状態で、`Antigravity日本語版.app` を起動

> **初回起動時の注意（Apple 未公証アプリ）**:
> 「開発元を確認できないため開けません」と表示された場合は、アプリを **右クリック（Control＋クリック）→「開く」** を選んで起動するか、ターミナルで以下を1回実行してください:
> ```bash
> xattr -dr com.apple.quarantine "/Applications/Antigravity日本語版.app"
> ```
>
> **必要な環境**: macOS 13 (Ventura) 以降（**Apple Silicon M1〜M4 / Intel Mac 完全両対応・Universal 版**）、本家 Antigravity。  
> ※ **Node.js・Rosetta 2・セットアップコマンドは不要**です（Universal Node.js ランタイムを `.app` 内に完全同梱しています）。

## 自分の AI に改造させたい時

このリポジトリを丸ごとクローン（または ZIP ダウンロード）して、お使いの AI エージェントに次のように伝えてください。

> 「このフォルダの `AI_CUSTOMIZE_GUIDE.md` を読んで、画面の配色をライトテーマ対応にして再ビルドして」

改造手順・ディレクトリ構造・Language Server の仕様・ビルドコマンドはすべて [AI_CUSTOMIZE_GUIDE.md](./AI_CUSTOMIZE_GUIDE.md) にまとめてあります。

## ライセンス

MIT License（ベース: [Porta](https://github.com/L1M80/porta)）
