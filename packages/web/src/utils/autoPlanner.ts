/**
 * Automatic execution mode classifier ("Auto" -> "Fast" vs "Plan").
 *
 * Keeps everyday prompts, bug fixes, questions, and "proceed without stopping"
 * instructions on Fast ("conversational"), while automatically switching
 * greenfield builds, full-architecture designs, and explicit planning requests
 * to Plan ("planning").
 */

export type PlannerMode = "auto" | "conversational" | "planning";
export type ResolvedPlannerType = "conversational" | "planning";

const IMMEDIATE_FAST_RE =
  /(止まら|どんどん|すぐ(に)?(進|作|直|や|実)|一気に|そのまま進|進めて(いい|くれ|ください|よ)?$|閉じて|アーカイブ|ありがとう|了解|オッケー|いいよ|\bfast\s*mode\b|ファストモード|即実行)/i;

const EXPLICIT_PLAN_RE =
  /(計画(書|を立て|から|モード|を作成)|設計(案|書|から|方針を先)|ロードマップを(作|策定)|まずは?プラン|\bplan\s*mode\b|プランモード|実装計画|方針を整理して確認)/i;

const LARGE_ARCHITECTURE_RE =
  /((一|ゼロ|イチ)から.{0,18}(作|構築|実装|設計|開発)|フルスクラッチ|全体(設計|アーキテクチャ|リファクタリング|構成)|大規模(な)?(改修|リファクタリング|移行|作り直し|システム)|全面(改修|刷新|書き換え|リニューアル)|アーキテクチャ(設計|刷新|見直し|構築)|新(しい|規)(アプリ|システム|基盤|プラットフォーム|サービス)を.{0,16}(構築|開発|設計|作))/i;

const QUESTION_ONLY_RE =
  /(何かな|どういう意味|とは何|教えて|なぜ|原因は|でしょうか|ますか|かな)[？?。\s]*$/i;

const STACKTRACE_OR_LOG_RE = /(Traceback \(most recent|Error:|Exception:|at\s+[\w.$]+\s*\()/;

export function classifyAutoPlannerType(rawText: string): ResolvedPlannerType {
  const text = (rawText ?? "").trim();
  if (text.length < 16) {
    return "conversational";
  }

  // Explicit user request for a plan always wins unless user said immediate fast mode
  if (EXPLICIT_PLAN_RE.test(text) && !/\bfast\s*mode\b|ファストモード|即実行/i.test(text)) {
    return "planning";
  }

  // Explicit "proceed immediately / don't stop" or short questions stay Fast
  if (IMMEDIATE_FAST_RE.test(text)) {
    return "conversational";
  }

  if (QUESTION_ONLY_RE.test(text) && !LARGE_ARCHITECTURE_RE.test(text)) {
    return "conversational";
  }

  // Greenfield / large architectural / major overhaul tasks switch to Plan
  if (LARGE_ARCHITECTURE_RE.test(text)) {
    return "planning";
  }

  // Multi-item specification (>= 220 chars, >= 4 bullet/numbered requirements, build/design verbs, not an error log)
  if (text.length >= 220 && !STACKTRACE_OR_LOG_RE.test(text)) {
    const bulletLines = text
      .split("\n")
      .filter((line) => /^\s*([-*•]|\d+[.)、])\s+\S+/.test(line)).length;
    if (
      bulletLines >= 4 &&
      /(構築|設計|実装|アーキテクチャ|マイグレーション|新機能|仕様)/.test(text)
    ) {
      return "planning";
    }
  }

  return "conversational";
}

export function resolvePlannerType(
  mode: PlannerMode | undefined,
  text: string,
): ResolvedPlannerType {
  if (mode === "planning") return "planning";
  if (mode === "conversational") return "conversational";
  return classifyAutoPlannerType(text);
}
