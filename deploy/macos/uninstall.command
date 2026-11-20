#!/bin/bash
set -euo pipefail

echo "=================================================="
echo "  Antigravity 日本語版 — アンインストール"
echo "=================================================="
echo ""
echo "以下を削除します（Google Antigravity 本体や会話履歴は一切消えません）："
echo "  ・/Applications/Antigravity日本語版.app"
echo "  ・~/Library/Application Support/AntigravityJP"
echo "  ・~/Library/Logs/AntigravityJP"
echo ""
read -r -p "本当にアンインストールしますか？ [y/N]: " CONFIRM

if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "キャンセルしました。"
  exit 0
fi

osascript -e 'tell application "Antigravity 日本語版" to quit' 2>/dev/null || true
pkill -f "AntigravityJP/runtime/proxy/dist/index.js" 2>/dev/null || true
sleep 1

rm -rf "/Applications/Antigravity日本語版.app"
rm -rf "$HOME/Library/Application Support/AntigravityJP"
rm -rf "$HOME/Library/Logs/AntigravityJP"

echo ""
echo "✅ アンインストールが完了しました。"
read -r -p "Enter キーを押して閉じます..."
