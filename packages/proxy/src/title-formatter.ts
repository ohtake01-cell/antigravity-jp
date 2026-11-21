/**
 * Smart Task-Focused Conversation Title Formatter (`title-formatter.ts`)
 *
 * Dynamically tracks the *current active work* of each conversation as concise
 * `[対象] 作業内容` noun phrases (14–24 chars):
 * 1. Preserves manual user renames (`<cid>.manual` lock file) untouched.
 * 2. Strips noisy status/handoff prefixes (`🔧`, `✅ 完了：`, `⏳ 待機中：`, `引き継ぎ：`)
 *    and suffixes (`（引き継ぎ）`) since the UI already renders live status indicators.
 * 3. Continuously re-evaluates from `transcript.jsonl` (cached by mtime) whenever
 *    a conversation progresses, so when the work topic shifts mid-chat, the chat
 *    title shifts automatically to match the latest substantive task!
 * 4. Ignores conversational follow-ups, feelings/status questions, and short replies
 *    ("完了したのかな？", "感想はどうだ？", "pdfの資料もあるよ", "完成度を高めてくれ")
 *    so they never corrupt the task title.
 * 5. Optionally refines the title asynchronously via local 0-yen Ollama (`qwen2.5:7b`
 *    / `qwen2.5:3b`) in the background (non-blocking, cached by substantive-request
 *    signature, disabled under VITEST) for natural human-grade Japanese task titles.
 */

import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGeminiBaseDir } from "./metadata.js";

const NOISE_PREFIX_RE =
  /^(?:[🔧⏳✅⏸📌📦💬🧠👑]\s*|(?:進行中|待機中|完了・終了|完了|確認待ち|引き継ぎ)[：:\s]+)+/u;
const NOISE_SUFFIX_RE = /(?:[（(]引き継ぎ[)）]|[。！!？?…・\s])+$/u;
const DANGLING_TAIL_RE = /[のをがにでとへはもや、,・／/（(「『]$/u;

const FOLLOWUP_OR_META_RE =
  /^(?:素晴らしい|ありがとう|ありがとね|了解|オッケー|ok\b|いいよ|進めて|止まら|どんどん|次(?:は|の|行こう|いこう|何)?|意見が聞きたい|どう思う|任せる|まかせる|おすすめで|とりあえずお願い|お願い(?:ね|します)?$|直して(?:くれ|ほしい)?$|できるかな|使える状態にして|おーい|こんにちは|このチャット閉じて|閉じてくれ|チャット名は|その仕組み|その作業が|それなら|これ(?:で|を|が|は)|掘り下げて|画像でわかりやすく|自動で追加されるように|終わったら|よろしく|後から機能を|作業を開始する前に|あなたはユーザーの頼れるAIアシスタント|そういうことができる|他にいい案|完了したのかな|終わったのかな|使ってみての感想|感想は|完成度を高めて|あともう一つ|もう一つ聞きたい)/iu;

const CONVERSATIONAL_ONLY_RE =
  /(?:のかな[？?]*$|どう思う[？?]*$|どうだ[？?]*$|意見だけを聞きたい|感想は[、,\s]*どう|資料があるよ|資料もあるはず|スライドもある|操作しやすいよ|悲しいよ$)/u;

const USER_REQ_BLOCK_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g;

const OLLAMA_TITLE_ENDPOINTS = [
  "http://127.0.0.1:11434",
];
const OLLAMA_TITLE_MODELS = ["qwen2.5:7b", "qwen2.5:3b", "qwen3.5:9b"];

interface CachedTranscriptSummary {
  mtimeMs: number;
  checkedAt: number;
  title: string | null;
  signature: string;
}

interface LlmTitleCacheEntry {
  signature: string;
  title: string;
}

const transcriptTitleCache = new Map<string, CachedTranscriptSummary>();
const llmTitleCache = new Map<string, LlmTitleCacheEntry>();
const llmTitleInflight = new Set<string>();
let cachedOllamaTitleTarget: { base: string; model: string; checkedAt: number } | null = null;

const TRANSCRIPT_FULL_READ_LIMIT_BYTES = 512 * 1024;
const TRANSCRIPT_HEAD_BYTES = 64 * 1024;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const TRANSCRIPT_MIN_REPARSE_MS = 4_000;

async function readTranscriptSample(
  transcriptPath: string,
  fileSize: number,
): Promise<string> {
  if (fileSize <= TRANSCRIPT_FULL_READ_LIMIT_BYTES) {
    return readFile(transcriptPath, "utf-8");
  }

  let fh;
  try {
    fh = await open(transcriptPath, "r");
    const headLen = Math.min(TRANSCRIPT_HEAD_BYTES, fileSize);
    const tailLen = Math.min(TRANSCRIPT_TAIL_BYTES, Math.max(0, fileSize - headLen));
    const headBuf = Buffer.allocUnsafe(headLen);
    const { bytesRead: headRead } = await fh.read(headBuf, 0, headLen, 0);
    let headText = headBuf.subarray(0, headRead).toString("utf-8");
    const lastHeadNl = headText.lastIndexOf("\n");
    if (lastHeadNl >= 0) {
      headText = headText.slice(0, lastHeadNl);
    }

    if (tailLen <= 0) return headText;

    const tailBuf = Buffer.allocUnsafe(tailLen);
    const tailOffset = Math.max(headLen, fileSize - tailLen);
    const { bytesRead: tailRead } = await fh.read(tailBuf, 0, tailLen, tailOffset);
    let tailText = tailBuf.subarray(0, tailRead).toString("utf-8");
    const firstTailNl = tailText.indexOf("\n");
    if (firstTailNl >= 0) {
      tailText = tailText.slice(firstTailNl + 1);
    }
    return `${headText}\n${tailText}`;
  } finally {
    await fh?.close();
  }
}

function resolveManualTitlesDir(): string {
  if (process.env.PORTA_MANUAL_TITLES_DIR) {
    return process.env.PORTA_MANUAL_TITLES_DIR;
  }
  if (process.env.VITEST) {
    return join(tmpdir(), `porta-vitest-manual-titles-${process.pid}`);
  }
  return join(homedir(), ".gemini", "antigravity", "jp-titles");
}

export async function saveManualTitleLock(
  id: string,
  title: string,
): Promise<void> {
  const clean = title.replace(/[\r\n\t]+/g, " ").trim();
  if (!id || !clean) return;
  try {
    const dir = resolveManualTitlesDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}.manual`), `${clean}\n`, "utf-8");
  } catch {
    // Non-fatal if manual titles dir is unavailable
  }
}

export async function getManualTitleLock(
  id: string,
): Promise<string | undefined> {
  if (!id) return undefined;
  try {
    const raw = await readFile(
      join(resolveManualTitlesDir(), `${id}.manual`),
      "utf-8",
    );
    const trimmed = raw.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

export function stripTitleNoise(raw: string): string {
  if (!raw) return "";
  let s = raw
    .replace(/<\/?(?:USER_REQUEST|ADDITIONAL_METADATA|CONTEXT_SUMMARY|SYSTEM_MESSAGE)[^>]*>/gi, " ")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  s = s.replace(NOISE_PREFIX_RE, "");
  s = s.replace(NOISE_SUFFIX_RE, "");
  s = s.replace(/\b(?:Prata|parta|Parta)\b/g, "Porta");
  
  return s.trim();
}

function clampTaskTitle(input: string, maxChars = 24): string {
  const chars = [...input.trim()];
  if (chars.length <= maxChars) {
    return input.trim().replace(DANGLING_TAIL_RE, "").trim();
  }
  const sliced = chars.slice(0, maxChars).join("");
  return sliced.replace(DANGLING_TAIL_RE, "").trim();
}

export function isConversationalOrBrokenTitle(raw: string): boolean {
  if (!raw) return true;
  const trimmed = raw.trim();
  if (trimmed.startsWith("🔧")) return true;
  const cleaned = stripTitleNoise(trimmed);
  if (!cleaned || cleaned.length < 3) return true;
  if (/^[0-9a-f]{8}…$/i.test(cleaned)) return true;
  if (FOLLOWUP_OR_META_RE.test(cleaned)) return true;
  if (CONVERSATIONAL_ONLY_RE.test(cleaned)) return true;
  if (/^(?:あと|ちなみに|それと)[、,\s]/u.test(cleaned)) return true;
  return false;
}

function isNonTaskUtterance(req: string): boolean {
  const cleaned = stripTitleNoise(req);
  if (cleaned.length < 4) return true;
  const firstLine = stripTitleNoise(req.split("\n")[0] ?? "");
  if (firstLine.length < 4) return true;
  // Specific strong task signals should NEVER be skipped even if phrased casually
  const hasStrongWorkIntent =
    /(?:チャット名.*(?:切り替|自動|変)|統合(?:したい|して|できる)|リブランド|アイコン.*作|設計して.*やって|バグ.*直|実装して|作成して|作り直|修正して|改善して|構築|移行)/u.test(
      cleaned,
    );
  if (hasStrongWorkIntent) return false;
  if (FOLLOWUP_OR_META_RE.test(firstLine) || FOLLOWUP_OR_META_RE.test(cleaned)) {
    return true;
  }
  if (CONVERSATIONAL_ONLY_RE.test(cleaned) && cleaned.length < 40) {
    return true;
  }
  return false;
}

function detectTargetSubject(
  recentTextsFirst: readonly string[],
  _paths: readonly string[],
): string {
  for (const t of recentTextsFirst) {
    const quoted = t.match(/『([^』]{2,14})』/);
    if (quoted?.[1]) {
      return quoted[1].trim();
    }
  }
  return "";
}

export function summarizeUserTaskPhrase(
  rawRequest: string,
  targetSubject = "",
): string {
  let text = stripTitleNoise(rawRequest);
  if (!text) return "";

  // Handle structured dispatch header: 【Sender／TASK-CODE】Body...
  const bracketMatch = text.match(/^【([^】]+)】\s*(.*)$/s);
  if (bracketMatch) {
    const header = bracketMatch[1];
    const rest = bracketMatch[2].trim();
    const sceneMatch = header.match(/\b(S\d{2}|Seq\d{2}|SCENE\d{2})\b/i);
    const sceneTag = sceneMatch ? sceneMatch[1].toUpperCase() : "";
    if (rest) {
      const firstSentence = rest.split(/[。\n]/)[0]?.trim() ?? "";
      const action = firstSentence
        .replace(/(?:を反映しました|の指摘を反映しました)$/u, "反映")
        .replace(/(?:の準備相談です|を正式配置しました|を正式に復旧しました)$/u, "")
        .replace(/(?:まで進めるよう指示済み)$/u, "")
        .trim();
      const base = [targetSubject, sceneTag, action]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ");
      if (base) return clampTaskTitle(base, 24);
    }
    const headerLabel = header.split(/[｜|／/]/)[0]?.trim() ?? header;
    return clampTaskTitle(
      [targetSubject, sceneTag, headerLabel].filter(Boolean).join(" "),
      24,
    );
  }

  // Strip conversational lead-ins
  text = text.replace(/^(?:あと|ちなみに|それと|今|今度は|まずは|俺の不満は)[、,\s]+/u, "");

  // High-signal composite task patterns
  if (
    (text.includes("チャット名") && (text.includes("切り替") || text.includes("作業に合わせ"))) ||
    text.includes("タイトル文字") ||
    (text.includes("チャット一覧") && text.includes("タイトル"))
  ) {
    text = text.includes("切り替") || text.includes("作業に合わせ")
      ? "チャット名自動切替の改善"
      : "チャットタイトル表示改善";
  } else if (
    (text.includes("Antigravity日本語版") || text.includes("チャットアプリ")) &&
    (text.includes("統合") || text.includes("振り分け") || text.includes("ネーム") || text.includes("アイコン"))
  ) {
    if (text.includes("アイコン") && !text.includes("統合") && !text.includes("チャットアプリ")) {
      text = "アイコン・名称リブランド";
    } else {
      text = "アプリ機能改善・統合";
    }
  } else if (text.includes("各AI") && text.includes("モデル名")) {
    text = "各AIモデル名の自動同期";
  } else if (text.includes("子チャットの表示") && text.includes("上位に移動")) {
    text = "子チャット表示・稼働順修正";
  } else if (text.includes("音声入力ボタン")) {
    text = "音声入力ボタンの追加";
  } else if (text.includes("ディスクトップ用") || text.includes("デスクトップ用")) {
    text = "Macデスクトップアプリ化";
  } else if (text.includes("2027年はどうなるか予測")) {
    text = "2027年予測・解説";
  } else {
    const firstClause =
      text
        .split(/[。\n]+/)
        .map((c) => c.trim())
        .find((c) => c.length >= 4 && !FOLLOWUP_OR_META_RE.test(c)) ??
      text.split(/[。\n]+/)[0]?.trim() ??
      text;

    text = firstClause
      .replace(/^この画像から/u, "")
      .replace(/(.+?)だと思うけど[、,\s]*/u, "")
      .replace(/(.+?)が(?:表示しない|表示されない|出ない|消えた).*$/u, "$1の表示修正")
      .replace(/(.+?)が(?:しなくなった|動かない|使えなくなってる).*$/u, "$1の不具合修正")
      .replace(/(.+?)のバグ.*直して.*$/u, "$1のバグ修正")
      .replace(/(.+?)ってなんだ[？?]*$/u, "$1の調査・解説")
      .replace(/(.+?)とは[？?]*$/u, "$1の調査・解説")
      .replace(/(.+?)が少ないね$/u, "$1の改善")
      .replace(/(.+?)がわかりにくくないか[？?]*$/u, "$1の改善")
      .replace(/(.+?)を?作れるかな[？?]*$/u, "$1の作成検討")
      .replace(/(.+?)を?予測してくれ.*$/u, "$1予測")
      .replace(/(.+?)(?:して欲しいな|してほしい|してくれ|お願いね|お願い|ことだな)$/u, "$1");
  }

  text = stripTitleNoise(text);
  if (
    targetSubject &&
    !text.toLowerCase().includes(targetSubject.toLowerCase())
  ) {
    text = `${targetSubject} ${text}`;
  }
  return clampTaskTitle(text, 24);
}

async function resolveFastOllamaTitleTarget(): Promise<{
  base: string;
  model: string;
} | null> {
  if (
    cachedOllamaTitleTarget &&
    Date.now() - cachedOllamaTitleTarget.checkedAt < 120_000
  ) {
    return {
      base: cachedOllamaTitleTarget.base,
      model: cachedOllamaTitleTarget.model,
    };
  }
  for (const base of OLLAMA_TITLE_ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 900);
    try {
      const resp = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const data = (await resp.json()) as { models?: Array<{ name?: string }> };
      const names = (data.models ?? [])
        .map((m) => m.name ?? "")
        .filter(Boolean);
      const picked =
        OLLAMA_TITLE_MODELS.find((m) => names.includes(m)) ??
        names.find((n) => !n.includes("embed") && !n.includes("bge"));
      if (picked) {
        cachedOllamaTitleTarget = { base, model: picked, checkedAt: Date.now() };
        return { base, model: picked };
      }
    } catch {
      clearTimeout(timer);
    }
  }
  return null;
}

function scheduleAsyncLlmTitle(
  id: string,
  signature: string,
  recentRequests: readonly string[],
  recentPaths: readonly string[],
): void {
  if (process.env.VITEST || process.env.PORTA_DISABLE_LLM_TITLE === "1") return;
  const existing = llmTitleCache.get(id);
  if (existing && existing.signature === signature) return;
  const key = `${id}:${signature}`;
  if (llmTitleInflight.has(key)) return;
  llmTitleInflight.add(key);

  void (async () => {
    try {
      const target = await resolveFastOllamaTitleTarget();
      if (!target) return;
      const reqSnippet = recentRequests
        .slice(-4)
        .map((r, i) => `${i + 1}. ${stripTitleNoise(r).slice(0, 140)}`)
        .join("\n");
      const fileSnippet = recentPaths
        .slice(-6)
        .map((p) => p.split("/").slice(-2).join("/"))
        .join(", ");
      const prompt = [
        "以下の直近の会話と編集ファイルから、今現在行っている最新の作業テーマを日本語の短いタイトル1つ（10〜20文字、名詞止め、絵文字なし、括弧や引用符なし、説明不要でタイトルのみ出力）にしてください。",
        "例: Antigravity日本語版 チャット名自動切替",
        "【直近の依頼】",
        reqSnippet,
        fileSnippet ? `【直近の関連ファイル】\n${fileSnippet}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const resp = await fetch(`${target.base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            model: target.model,
            stream: false,
            messages: [
              {
                role: "system",
                content:
                  "作業タイトル生成器です。前置きや記号なしで10〜20文字の名詞止め日本語タイトル1行だけを返してください。",
              },
              { role: "user", content: prompt },
            ],
            options: { temperature: 0.1, num_predict: 40 },
          }),
        });
        clearTimeout(timer);
        if (!resp.ok) return;
        const json = (await resp.json()) as {
          message?: { content?: string };
        };
        const rawOut = (json.message?.content ?? "")
          .split("\n")[0]
          ?.replace(/^["'「『【\s]+|["'」』】\s]+$/gu, "")
          .trim();
        const clean = clampTaskTitle(stripTitleNoise(rawOut ?? ""), 24);
        if (clean.length >= 4 && !isConversationalOrBrokenTitle(clean)) {
          llmTitleCache.set(id, { signature, title: clean });
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Non-fatal background refinement
    } finally {
      llmTitleInflight.delete(key);
    }
  })();
}

async function deriveTaskTitleFromTranscript(id: string): Promise<string | null> {
  const geminiBase = resolveGeminiBaseDir();
  const transcriptPath = join(
    geminiBase,
    "antigravity",
    "brain",
    id,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );

  let st;
  try {
    st = await stat(transcriptPath);
  } catch {
    return null;
  }

  const cached = transcriptTitleCache.get(id);
  const now = Date.now();
  if (
    cached &&
    (cached.mtimeMs === st.mtimeMs ||
      (!process.env.VITEST && now - cached.checkedAt < TRANSCRIPT_MIN_REPARSE_MS))
  ) {
    const llm = llmTitleCache.get(id);
    if (llm && llm.signature === cached.signature) {
      return llm.title;
    }
    return cached.title;
  }

  try {
    const raw = await readTranscriptSample(transcriptPath, st.size);
    const userRequests: string[] = [];
    const touchedPaths: string[] = [];

    for (const line of raw.split("\n")) {
      if (!line) continue;
      if (!line.includes('"USER_INPUT"') && !line.includes('"Path"')) continue;
      let row: {
        type?: string;
        content?: string;
        tool_calls?: Array<{
          arguments?: Record<string, unknown>;
          args?: Record<string, unknown>;
        }>;
      };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }

      if (row.type === "USER_INPUT" && typeof row.content === "string") {
        if (row.content.includes("<USER_REQUEST>")) {
          for (const m of row.content.matchAll(USER_REQ_BLOCK_RE)) {
            const body = m[1]?.trim();
            if (body) {
              userRequests.push(body);
            }
          }
        } else if (row.content.trim()) {
          userRequests.push(row.content.trim());
        }
      }

      if (Array.isArray(row.tool_calls)) {
        for (const tc of row.tool_calls) {
          const args = tc.arguments ?? tc.args;
          const p = args?.Path;
          if (typeof p === "string" && p) {
            touchedPaths.push(p);
          }
        }
      }
    }

    const nonHandoffSubstantive: string[] = [];
    let handoffFallback: string | null = null;

    for (const req of userRequests) {
      if (
        req.includes("文脈トークン量が重くなった") ||
        req.includes("# 引き継ぎ書")
      ) {
        const hm = req.match(/##\s*1\.\s*完了範囲[\s\S]*?1\.\s*\*\*(.+?)\*\*/);
        if (hm?.[1]) {
          handoffFallback = clampTaskTitle(stripTitleNoise(hm[1]), 24);
        }
        continue;
      }
      if (isNonTaskUtterance(req)) {
        continue;
      }
      nonHandoffSubstantive.push(req);
    }

    let resolved: string | null = null;
    const recentPaths = touchedPaths.slice(-30);
    const signature = `${nonHandoffSubstantive.length}:${(nonHandoffSubstantive[nonHandoffSubstantive.length - 1] ?? "").slice(0, 60)}`;

    if (nonHandoffSubstantive.length > 0) {
      const latestReq = nonHandoffSubstantive[nonHandoffSubstantive.length - 1];
      // Pass recent requests in reverse chronological order so newer topics always win!
      const recentFirst = [...nonHandoffSubstantive].reverse();
      const anchor = detectTargetSubject(recentFirst, recentPaths);
      resolved = summarizeUserTaskPhrase(latestReq, anchor) || null;
      scheduleAsyncLlmTitle(id, signature, nonHandoffSubstantive, recentPaths);
    } else if (handoffFallback) {
      resolved = handoffFallback;
    }

    transcriptTitleCache.set(id, {
      mtimeMs: st.mtimeMs,
      checkedAt: now,
      title: resolved,
      signature,
    });

    const llm = llmTitleCache.get(id);
    if (llm && llm.signature === signature) {
      return llm.title;
    }
    return resolved;
  } catch {
    return null;
  }
}

export async function resolveSmartConversationTitle(
  id: string,
  diskTitle: string | undefined,
  lsSummary: string | undefined,
): Promise<string | undefined> {
  // 1. User manual rename is always honored verbatim
  const manual = await getManualTitleLock(id);
  if (manual) return manual;

  // 2. Respect explicit non-empty disk annotation title or clean LS summary
  //    so existing Antigravity titles are never overwritten with spurious guesses.
  const cleanedDisk = stripTitleNoise(diskTitle ?? "");
  if (cleanedDisk && !isConversationalOrBrokenTitle(cleanedDisk)) {
    return clampTaskTitle(cleanedDisk, 28);
  }

  const cleanedSummary = stripTitleNoise(lsSummary ?? "");
  if (cleanedSummary && !isConversationalOrBrokenTitle(cleanedSummary)) {
    return clampTaskTitle(cleanedSummary, 28);
  }

  // 3. Only derive dynamically from transcript when no clean title exists yet
  const derived = await deriveTaskTitleFromTranscript(id);
  if (derived) {
    return derived;
  }

  const rawPrimary = diskTitle?.trim() || lsSummary?.trim() || "";
  if (rawPrimary) {
    return clampTaskTitle(stripTitleNoise(rawPrimary) || rawPrimary, 28);
  }

  return undefined;
}
