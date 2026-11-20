# Antigravity 日本語版（シンプル・Gemini専用エディション）

Mac 上のローカル [Antigravity](https://antigravity.google/)（Language Server）に接続して使う、**日本語ネイティブのチャット＆エージェント UI（macOS アプリ + ローカルブリッジ）**です。

> 本アプリは MIT ライセンスの [Porta](https://github.com/L1M80/porta) をベースに、日本語チャット体験・コンテキスト重み表示・サブエージェント階層表示・枝分かれ検証・アーティファクトビューア・macOS ネイティブアプリ化を行ったシンプル版です。

## 主な機能

- **完全日本語 UI ＆ 日本語応答ルールワンクリック設定**（`~/.gemini/GEMINI.md`）
- **AI の重み・枠の見える化**: 残りクォータ率・コンテキスト使用量バッジ・7日間のトークン推移
- **整理されたチャット一覧**: ピン留め・実行中セクション・プロジェクト別グループ・**親チャット配下への子チャット（サブエージェント）ツリー収納**・自動日本語タイトル化
- **エージェント監視パネル ＆ 枝分かれチャット（🌿）**: 本流の文脈を汚さずに Gemini で仮説検証・サブエージェントのリアルタイム監視
- **右ペイン・アーティファクトビューア**: Markdown / Mermaid 図 / CSV / 画像 / PDF プレビュー
- **⌘K コマンドパレット ＆ 音声入力 ＆ ファイル D&D**
- **Local Permissions 切り替え**: コマンド自動実行ポリシー（確認あり〜フル自動）をチャット入力欄から切替可能

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
> **必要な環境**: macOS（Apple Silicon / Intel 両対応 Universal Binary）、Node.js 20 以上、本家 Antigravity。

## 自分の AI に改造させたい時

このリポジトリを丸ごとクローン（または ZIP ダウンロード）して、お使いの AI エージェントに次のように伝えてください。

> 「このフォルダの `AI_CUSTOMIZE_GUIDE.md` を読んで、画面の配色をライトテーマ対応にして再ビルドして」

改造手順・ディレクトリ構造・Language Server の仕様・ビルドコマンドはすべて [AI_CUSTOMIZE_GUIDE.md](./AI_CUSTOMIZE_GUIDE.md) にまとめてあります。

## ライセンス

MIT License（ベース: [Porta](https://github.com/L1M80/porta)）
