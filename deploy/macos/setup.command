#!/bin/bash
set -euo pipefail

# Antigravity 日本語版 — Mac かんたんセットアップ
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SUPPORT_DIR="$HOME/Library/Application Support/AntigravityJP"
RUNTIME_DEST="$SUPPORT_DIR/runtime"
APP_SRC="$SCRIPT_DIR/Antigravity日本語版.app"
APP_DEST="/Applications/Antigravity日本語版.app"
PORT_DEFAULT="3470"

echo "=================================================="
echo "  Antigravity 日本語版（Mac ネイティブアプリ）セットアップ"
echo "=================================================="
echo ""

# 1. Node.js 確認（アプリ内蔵の Universal Node.js があればシステム側の導入は不要）
BUNDLED_NODE="$APP_SRC/Contents/Resources/runtime/bin/node"
if [ -x "$BUNDLED_NODE" ]; then
  NODE_VER="$("$BUNDLED_NODE" -v 2>/dev/null || echo "内蔵Universal")"
  echo "✅ アプリ内蔵の Universal Node.js を使用します: $NODE_VER（追加インストール不要）"
else
  export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.fnm/current/bin:$PATH"
  if [ -d "$HOME/.nvm/versions/node" ]; then
    LATEST_NVM="$(ls -1 "$HOME/.nvm/versions/node" | sort -V | tail -n 1 || true)"
    if [ -n "$LATEST_NVM" ]; then
      export PATH="$HOME/.nvm/versions/node/$LATEST_NVM/bin:$PATH"
    fi
  fi

  NODE_BIN="$(command -v node || true)"
  if [ -z "$NODE_BIN" ]; then
    echo "❌ Node.js が見つかりませんでした。"
    echo ""
    echo "以下のいずれかの方法で Node.js（v22 以上）をインストールしてから、もう一度このファイルを開いてください："
    echo "  ・公式サイト: https://nodejs.org/"
    echo "  ・Homebrew:   brew install node"
    echo ""
    read -r -p "Enter キーを押して閉じます..."
    exit 1
  fi

  NODE_VER="$("$NODE_BIN" -v)"
  echo "✅ Node.js を検出しました: $NODE_VER ($NODE_BIN)"
fi

# 2. Antigravity インストール確認（警告のみ・続行可能）
if [ -d "/Applications/Antigravity.app" ] || [ -d "/Applications/Antigravity IDE.app" ] || [ -x "$HOME/.gemini/bin/agy" ] || command -v agy >/dev/null 2>&1; then
  echo "✅ Google Antigravity を検出しました"
else
  echo "⚠️ Google Antigravity がまだ見つかりませんでした。"
  echo "   先に https://antigravity.google/ からインストール＆ログインしておくとすぐ使えます。"
fi

# 3. 既存プロセスの安全な停止（この日本語版のみ）
pkill -f "AntigravityJP/runtime/proxy/dist/index.js" 2>/dev/null || true
pkill -f "Antigravity日本語版.app/Contents/Resources/runtime/proxy/dist/index.js" 2>/dev/null || true
osascript -e 'tell application "Antigravity 日本語版" to quit' 2>/dev/null || true
sleep 1

# 4. ランタイム配置（外付け runtime がある配布セットのみコピー。DMG単体完結版は .app 内蔵ランタイムをそのまま使用）
mkdir -p "$SUPPORT_DIR"
if [ -d "$SCRIPT_DIR/runtime" ] && [ ! -d "$APP_SRC/Contents/Resources/runtime" ]; then
  echo ""
  echo "📦 アプリのランタイムを配置しています..."
  rm -rf "$RUNTIME_DEST"
  cp -R "$SCRIPT_DIR/runtime" "$RUNTIME_DEST"
  echo "✅ ランタイム配置完了: $RUNTIME_DEST"
fi

if [ ! -f "$SUPPORT_DIR/config.env" ]; then
  cat > "$SUPPORT_DIR/config.env" <<EOF
PORTA_HOST=127.0.0.1
PORTA_PORT=$PORT_DEFAULT
PORTA_STANDALONE_CORE=true
EOF
fi

# 5. アプリ本体を /Applications へインストール
echo ""
echo "🚀 /Applications/Antigravity日本語版.app をインストールしています..."
if [ ! -d "$APP_SRC" ]; then
  echo "❌ 同梱の Antigravity日本語版.app が見つかりません。"
  read -r -p "Enter キーを押して閉じます..."
  exit 1
fi

rm -rf "$APP_DEST"
ditto "$APP_SRC" "$APP_DEST"
xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true
codesign --force --deep --sign - "$APP_DEST" >/dev/null 2>&1 || true

LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREG" ]; then
  "$LSREG" -f "$APP_DEST" >/dev/null 2>&1 || true
fi
echo "✅ インストール完了: $APP_DEST"

# 6. AI 応答の日本語グローバルルール設定（任意・おすすめ）
echo ""
echo "📝 Antigravity の AI 返答・計画書も自動で日本語にするグローバルルールを"
echo "   ~/.gemini/GEMINI.md へ追加しますか？（既存ファイルがある場合は自動バックアップします）"
read -r -p "追加する場合は y を押して Enter [Y/n]: " ADD_RULE
ADD_RULE="${ADD_RULE:-Y}"

if [[ "$ADD_RULE" =~ ^[Yy]$ ]]; then
  RULE_FILE="$HOME/.gemini/GEMINI.md"
  mkdir -p "$HOME/.gemini"
  if [ -f "$RULE_FILE" ] && grep -q "antigravity-jp-rule:start" "$RULE_FILE"; then
    echo "✅ 日本語運用ルールはすでに設定済みです。"
  else
    if [ -f "$RULE_FILE" ]; then
      BAK="$RULE_FILE.bak-$(date +%Y%m%d-%H%M%S)"
      cp "$RULE_FILE" "$BAK"
      echo "💾 既存ファイルをバックアップしました: $BAK"
      printf "\n\n" >> "$RULE_FILE"
    fi
    cat >> "$RULE_FILE" <<'RULE_EOF'
<!-- antigravity-jp-rule:start -->
# 日本語運用ルール（Antigravity 日本語版）
- ユーザーへの返答、進捗報告、質問、エラー解説はすべて自然な日本語で行うこと。
- 計画書、タスク一覧、レポート（Artifact を含む）も必ず日本語で作成すること。
- 英語のエラーや専門用語が出たときは、必要に応じて原文を添えつつ日本語でわかりやすく説明すること。
- コード内コメントやドキュメントも、特段の指定がない限り日本語で書くこと。
- ファイルを削除する・大きな変更を行う・方針が分かれるときは、勝手に進めず先に日本語で確認すること。
- できないことや制約があるときは、推測で補わず最初に正直に日本語で伝えること。
<!-- antigravity-jp-rule:end -->
RULE_EOF
    echo "✅ 日本語運用ルールを設定しました: $RULE_FILE"
  fi
fi

echo ""
echo "=================================================="
echo "  🎉 セットアップ完了！「Antigravity 日本語版」を起動します"
echo "=================================================="
echo "※ 初回は Google Antigravity を起動・ログインした状態でご利用ください。"
echo ""

open "$APP_DEST"
sleep 2
