/**
 * 拡張機能・カスタマイズ統合管理パネル
 * - 🧠 パーソナルメモリ（GEMINI.md へ自動同期）
 * - 🔌 MCP サーバー（外部ツール連携）
 * - 📚 スキル（SKILL.md 自動生成・管理）
 * - 📦 プラグイン（一覧・GitHub URL / ローカルフォルダ導入）
 * - 📜 共通ルール（グローバル GEMINI.md 編集）
 */

import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";
import type {
  ExtensionOverviewResponse,
  MemoryItem,
} from "../types";

type ExtTab = "memories" | "mcp" | "skills" | "plugins" | "rules";

const MCP_PRESETS: ReadonlyArray<{
  label: string;
  desc: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string;
  url?: string;
}> = [
  {
    label: "Filesystem（ファイル操作）",
    desc: "指定フォルダの読み書きツールを追加",
    name: "filesystem",
    transport: "stdio",
    command: "npx",
    args: "-y @modelcontextprotocol/server-filesystem ~/Documents",
  },
  {
    label: "Fetch（Web取得）",
    desc: "WebページをMarkdownで取得",
    name: "fetch",
    transport: "stdio",
    command: "uvx",
    args: "mcp-server-fetch",
  },
  {
    label: "Memory（知識グラフ）",
    desc: "セッションを跨ぐ永続メモリMCP",
    name: "memory",
    transport: "stdio",
    command: "npx",
    args: "-y @modelcontextprotocol/server-memory",
  },
  {
    label: "Sequential Thinking",
    desc: "段階的思考ツールを追加",
    name: "sequential-thinking",
    transport: "stdio",
    command: "npx",
    args: "-y @modelcontextprotocol/server-sequential-thinking",
  },
];

const MEMORY_CATEGORY_LABELS: Record<MemoryItem["category"], string> = {
  profile: "プロフィール",
  preference: "好み・方針",
  project: "作業環境",
  other: "その他",
};

export function ExtensionsPanel() {
  const [tab, setTab] = useState<ExtTab>(() => {
    try {
      const initial = sessionStorage.getItem("ext-panel-initial-tab");
      if (
        initial === "memories" ||
        initial === "mcp" ||
        initial === "skills" ||
        initial === "plugins" ||
        initial === "rules"
      ) {
        sessionStorage.removeItem("ext-panel-initial-tab");
        return initial;
      }
    } catch {
      // ignore
    }
    return "memories";
  });
  const [data, setData] = useState<ExtensionOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    text: string;
    isError?: boolean;
  } | null>(null);

  // Memory form
  const [memTitle, setMemTitle] = useState("");
  const [memContent, setMemContent] = useState("");
  const [memCategory, setMemCategory] =
    useState<MemoryItem["category"]>("preference");

  // MCP form
  const [mcpName, setMcpName] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"stdio" | "http">("stdio");
  const [mcpCommand, setMcpCommand] = useState("npx");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");

  // Skill form
  const [skillName, setSkillName] = useState("");
  const [skillDesc, setSkillDesc] = useState("");
  const [skillInstructions, setSkillInstructions] = useState("");
  const [showBuiltinSkills, setShowBuiltinSkills] = useState(false);

  // Plugin install form
  const [pluginSource, setPluginSource] = useState("");

  // Global rules
  const [rulesDraft, setRulesDraft] = useState("");
  const [rulesDirty, setRulesDirty] = useState(false);

  const showMessage = useCallback((text: string, isError = false) => {
    setFeedback({ text, isError });
    window.setTimeout(() => {
      setFeedback((prev) => (prev?.text === text ? null : prev));
    }, 4500);
  }, []);

  const load = useCallback(async () => {
    if (typeof api.extensionsOverview !== "function") {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.extensionsOverview();
      setData(res);
      setRulesDraft(res.globalRules ?? "");
      setRulesDirty(false);
    } catch (err) {
      showMessage(
        err instanceof Error
          ? `読み込みに失敗しました: ${err.message}`
          : "拡張機能の読み込みに失敗しました",
        true,
      );
    } finally {
      setLoading(false);
    }
  }, [showMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onFocusTab = (ev: Event) => {
      const custom = ev as CustomEvent<{ tab?: ExtTab }>;
      const next = custom.detail?.tab;
      if (
        next === "memories" ||
        next === "mcp" ||
        next === "skills" ||
        next === "plugins" ||
        next === "rules"
      ) {
        setTab(next);
      }
    };
    window.addEventListener("ext-panel:focus-tab", onFocusTab);
    return () => window.removeEventListener("ext-panel:focus-tab", onFocusTab);
  }, []);

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memContent.trim()) return;
    setBusy(true);
    try {
      await api.saveMemory({
        title: memTitle.trim() || "メモ",
        content: memContent.trim(),
        category: memCategory,
        enabled: true,
      });
      setMemTitle("");
      setMemContent("");
      showMessage("🧠 メモリを保存し、AI共通ルールへ自動同期しました");
      await load();
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : "メモリの保存に失敗しました",
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleToggleMemory = async (item: MemoryItem) => {
    setBusy(true);
    try {
      await api.updateMemory(item.id, { enabled: !item.enabled });
      await load();
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : "切替に失敗しました",
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    setBusy(true);
    try {
      await api.deleteMemory(id);
      showMessage("メモリを削除しました");
      await load();
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : "削除に失敗しました",
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSaveMcp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mcpName.trim()) return;
    setBusy(true);
    try {
      await api.saveMcpServer({
        name: mcpName.trim(),
        transport: mcpTransport,
        ...(mcpTransport === "http"
          ? { url: mcpUrl.trim() }
          : {
              command: mcpCommand.trim(),
              args: mcpArgs
                .trim()
                .split(/\s+/)
                .filter(Boolean),
            }),
      });
      setMcpName("");
      setMcpArgs("");
      setMcpUrl("");
      showMessage("🔌 MCP サーバーを登録しました（次回セッションから反映）");
      await load();
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : "MCP 登録に失敗しました",
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleToggleMcp = async (name: string, currentlyDisabled: boolean) => {
    setBusy(true);
    try {
      await api.toggleMcpServer(name, !currentlyDisabled);
      await load();
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : "切替に失敗しました",
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteMcp = async (name: string) => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`MCP サーバー「${name}」を削除しますか？`)
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.deleteMcpServer(name);
      showMessage(`MCP「${name}」を削除しました`);
      await load();
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : "削除に失敗しました",
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!skillName.trim() || !skillInstructions.trim()) return;
    setBusy(true);
    try {
      await api.saveSkill({
        name: skillName.trim(),
        description: skillDesc.trim(),
        instructions: skillInstructions.trim(),
      });
      setSkillName("");
      setSkillDesc("");
      setSkillInstructions("");
      showMessage("📚 新しいスキル（SKILL.md）を作成しました");
      await load();
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : "スキル作成に失敗しました",
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteSkill = async (slug: string) => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`自作スキル「${slug}」を削除しますか？`)
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.deleteSkill(slug);
      showMessage(`スキル「${slug}」を削除しました`);
      await load();
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : "削除に失敗しました",
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleInstallPlugin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pluginSource.trim()) return;
    setBusy(true);
    try {
      const res = await api.installPluginOrSkill(pluginSource.trim());
      setPluginSource("");
      showMessage(
        `📦 「${res.name}」を${res.installedAs === "skill" ? "スキル" : "プラグイン"}として導入しました`,
      );
      await load();
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : "導入に失敗しました",
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDeletePlugin = async (id: string) => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`プラグイン「${id}」を削除しますか？`)
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.deletePlugin(id);
      showMessage(`プラグイン「${id}」を削除しました`);
      await load();
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : "削除に失敗しました",
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSaveRules = async () => {
    setBusy(true);
    try {
      await api.saveGlobalRules(rulesDraft);
      setRulesDirty(false);
      showMessage("📜 共通ルール（GEMINI.md）を保存しました");
      await load();
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : "ルール保存に失敗しました",
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const userSkills = (data?.skills ?? []).filter((s) => s.source === "user");
  const otherSkills = (data?.skills ?? []).filter((s) => s.source !== "user");

  return (
    <div className="settings-section ext-panel" data-testid="extensions-panel">
      <div className="settings-section-header-row">
        <h2 className="settings-section-title">
          🧩 メモリ・MCP・スキル・プラグイン
        </h2>
        <button
          type="button"
          className="settings-archive-btn"
          disabled={loading || busy}
          onClick={() => void load()}
        >
          再読込
        </button>
      </div>
      <p className="settings-archive-desc">
        Antigravity 本体の設定（<code>~/.gemini/config/</code>）と直結して、AI の記憶・外部ツール（MCP）・手順書（スキル）・プラグイン・共通ルールを日本語で管理できます。
      </p>

      {feedback && (
        <div
          className={`ext-feedback ${feedback.isError ? "error" : "ok"}`}
          role="status"
        >
          {feedback.text}
        </div>
      )}

      <div className="ext-tabs" role="tablist">
        {(
          [
            ["memories", `🧠 メモリ (${data?.memories.length ?? 0})`],
            ["mcp", `🔌 MCP (${data?.mcpServers.length ?? 0})`],
            ["skills", `📚 スキル (${userSkills.length})`],
            ["plugins", `📦 プラグイン (${data?.plugins.length ?? 0})`],
            ["rules", "📜 共通ルール"],
          ] as Array<[ExtTab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`ext-tab-btn ${tab === id ? "active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <div className="settings-archive-empty">読み込み中…</div>
      ) : tab === "memories" ? (
        <div className="ext-tab-body">
          <p className="ext-hint">
            ChatGPT / Claude の「Memory」のように、自分の好みやよく使う環境を登録しておくと、すべてのチャットで AI が自動で前提として記憶します。
          </p>
          <form className="ext-form" onSubmit={(e) => void handleAddMemory(e)}>
            <div className="ext-form-row">
              <input
                type="text"
                className="ext-input"
                placeholder="タイトル（例: 返答スタイル・使用OS）"
                value={memTitle}
                onChange={(e) => setMemTitle(e.target.value)}
                disabled={busy}
              />
              <select
                className="ext-select"
                value={memCategory}
                onChange={(e) =>
                  setMemCategory(e.target.value as MemoryItem["category"])
                }
                disabled={busy}
              >
                <option value="preference">好み・方針</option>
                <option value="profile">プロフィール</option>
                <option value="project">作業環境</option>
                <option value="other">その他</option>
              </select>
            </div>
            <textarea
              className="ext-textarea"
              rows={2}
              placeholder="AIに覚えてほしい内容（例: 専門用語は噛み砕いて説明してほしい / TypeScript 優先で書いてほしい）"
              value={memContent}
              onChange={(e) => setMemContent(e.target.value)}
              disabled={busy}
            />
            <button
              type="submit"
              className="settings-archive-btn primary"
              disabled={busy || !memContent.trim()}
            >
              ＋ メモリを追加
            </button>
          </form>

          <div className="ext-list">
            {(data?.memories ?? []).length === 0 ? (
              <div className="settings-archive-empty">
                まだメモリは登録されていません
              </div>
            ) : (
              (data?.memories ?? []).map((m) => (
                <div
                  key={m.id}
                  className={`ext-item ${m.enabled ? "" : "disabled"}`}
                >
                  <div className="ext-item-info">
                    <div className="ext-item-title-row">
                      <span className="ext-badge">
                        {MEMORY_CATEGORY_LABELS[m.category] ?? "その他"}
                      </span>
                      <span className="ext-item-title">{m.title}</span>
                    </div>
                    <div className="ext-item-desc">{m.content}</div>
                  </div>
                  <div className="ext-item-actions">
                    <button
                      type="button"
                      className="settings-archive-btn"
                      disabled={busy}
                      onClick={() => void handleToggleMemory(m)}
                    >
                      {m.enabled ? "ON" : "OFF"}
                    </button>
                    <button
                      type="button"
                      className="settings-archive-btn danger"
                      disabled={busy}
                      onClick={() => void handleDeleteMemory(m.id)}
                    >
                      削除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : tab === "mcp" ? (
        <div className="ext-tab-body">
          <p className="ext-hint">
            外部ツール（MCP サーバー）を JSON 手書きなしで追加・ON/OFF できます。定番テンプレートからワンクリック入力も可能です。
          </p>
          <div className="ext-presets">
            {MCP_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                className="ext-preset-chip"
                title={p.desc}
                onClick={() => {
                  setMcpName(p.name);
                  setMcpTransport(p.transport);
                  setMcpCommand(p.command ?? "npx");
                  setMcpArgs(p.args ?? "");
                  setMcpUrl(p.url ?? "");
                }}
              >
                ＋ {p.label}
              </button>
            ))}
          </div>

          <form className="ext-form" onSubmit={(e) => void handleSaveMcp(e)}>
            <div className="ext-form-row">
              <input
                type="text"
                className="ext-input"
                placeholder="サーバー名（英数字・例: github）"
                value={mcpName}
                onChange={(e) => setMcpName(e.target.value)}
                disabled={busy}
              />
              <select
                className="ext-select"
                value={mcpTransport}
                onChange={(e) =>
                  setMcpTransport(e.target.value as "stdio" | "http")
                }
                disabled={busy}
              >
                <option value="stdio">コマンド実行 (stdio)</option>
                <option value="http">URL 接続 (HTTP/SSE)</option>
              </select>
            </div>
            {mcpTransport === "http" ? (
              <input
                type="url"
                className="ext-input"
                placeholder="https://example.com/mcp"
                value={mcpUrl}
                onChange={(e) => setMcpUrl(e.target.value)}
                disabled={busy}
              />
            ) : (
              <div className="ext-form-row">
                <input
                  type="text"
                  className="ext-input"
                  style={{ maxWidth: 140 }}
                  placeholder="コマンド (npx)"
                  value={mcpCommand}
                  onChange={(e) => setMcpCommand(e.target.value)}
                  disabled={busy}
                />
                <input
                  type="text"
                  className="ext-input"
                  placeholder="引数（スペース区切り・例: -y @modelcontextprotocol/server-memory）"
                  value={mcpArgs}
                  onChange={(e) => setMcpArgs(e.target.value)}
                  disabled={busy}
                />
              </div>
            )}
            <button
              type="submit"
              className="settings-archive-btn primary"
              disabled={
                busy ||
                !mcpName.trim() ||
                (mcpTransport === "http" ? !mcpUrl.trim() : !mcpCommand.trim())
              }
            >
              ＋ MCP を追加 / 更新
            </button>
          </form>

          <div className="ext-list">
            {(data?.mcpServers ?? []).length === 0 ? (
              <div className="settings-archive-empty">
                登録されている MCP サーバーはありません
              </div>
            ) : (
              (data?.mcpServers ?? []).map((s) => (
                <div
                  key={s.name}
                  className={`ext-item ${s.disabled ? "disabled" : ""}`}
                >
                  <div className="ext-item-info">
                    <div className="ext-item-title-row">
                      <span className="ext-badge">
                        {s.transport === "http" ? "HTTP" : "STDIO"}
                      </span>
                      <span className="ext-item-title">{s.name}</span>
                    </div>
                    <div className="ext-item-desc">
                      {s.transport === "http"
                        ? s.url
                        : `${s.command ?? ""} ${(s.args ?? []).join(" ")}`}
                    </div>
                  </div>
                  <div className="ext-item-actions">
                    <button
                      type="button"
                      className="settings-archive-btn"
                      disabled={busy}
                      onClick={() => void handleToggleMcp(s.name, s.disabled)}
                    >
                      {s.disabled ? "OFF" : "ON"}
                    </button>
                    <button
                      type="button"
                      className="settings-archive-btn danger"
                      disabled={busy}
                      onClick={() => void handleDeleteMcp(s.name)}
                    >
                      削除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : tab === "skills" ? (
        <div className="ext-tab-body">
          <p className="ext-hint">
            AI に覚えてほしい作業手順を日本語で書くだけで、Antigravity 用の <code>SKILL.md</code> を自動作成します。
          </p>
          <form className="ext-form" onSubmit={(e) => void handleSaveSkill(e)}>
            <input
              type="text"
              className="ext-input"
              placeholder="スキル名（例: 議事録まとめ / コードレビュー手順）"
              value={skillName}
              onChange={(e) => setSkillName(e.target.value)}
              disabled={busy}
            />
            <input
              type="text"
              className="ext-input"
              placeholder="いつ使うか（例: 会議メモを整理してほしい時に使う）"
              value={skillDesc}
              onChange={(e) => setSkillDesc(e.target.value)}
              disabled={busy}
            />
            <textarea
              className="ext-textarea"
              rows={3}
              placeholder="具体的な手順・ルール（例: 1. 決定事項を箇条書き 2. 担当者・期限を表にまとめる）"
              value={skillInstructions}
              onChange={(e) => setSkillInstructions(e.target.value)}
              disabled={busy}
            />
            <button
              type="submit"
              className="settings-archive-btn primary"
              disabled={busy || !skillName.trim() || !skillInstructions.trim()}
            >
              ＋ スキルを作成
            </button>
          </form>

          <div className="ext-list">
            {userSkills.length === 0 ? (
              <div className="settings-archive-empty">
                自作スキルはまだありません
              </div>
            ) : (
              userSkills.map((sk) => (
                <div key={sk.slug} className="ext-item">
                  <div className="ext-item-info">
                    <div className="ext-item-title-row">
                      <span className="ext-badge">自作</span>
                      <span className="ext-item-title">{sk.name}</span>
                    </div>
                    <div className="ext-item-desc">
                      {sk.description || sk.bodyPreview}
                    </div>
                  </div>
                  <div className="ext-item-actions">
                    <button
                      type="button"
                      className="settings-archive-btn danger"
                      disabled={busy}
                      onClick={() => void handleDeleteSkill(sk.slug)}
                    >
                      削除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {otherSkills.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                className="settings-archive-btn"
                onClick={() => setShowBuiltinSkills((v) => !v)}
              >
                {showBuiltinSkills
                  ? "標準・プラグイン同梱スキルを閉じる"
                  : `標準・プラグイン同梱スキルを表示 (${otherSkills.length}件)`}
              </button>
              {showBuiltinSkills && (
                <div className="ext-list" style={{ marginTop: 8 }}>
                  {otherSkills.map((sk) => (
                    <div key={`${sk.source}:${sk.slug}`} className="ext-item">
                      <div className="ext-item-info">
                        <div className="ext-item-title-row">
                          <span className="ext-badge">
                            {sk.source === "plugin"
                              ? sk.pluginName || "プラグイン"
                              : "標準"}
                          </span>
                          <span className="ext-item-title">{sk.name}</span>
                        </div>
                        <div className="ext-item-desc">
                          {sk.description || sk.bodyPreview}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : tab === "plugins" ? (
        <div className="ext-tab-body">
          <p className="ext-hint">
            GitHub の公開リポジトリ URL（<code>https://github.com/owner/repo</code>）またはローカルフォルダパスを指定して、プラグイン／スキルを直接導入できます。
          </p>
          <form
            className="ext-form"
            onSubmit={(e) => void handleInstallPlugin(e)}
          >
            <div className="ext-form-row">
              <input
                type="text"
                className="ext-input"
                placeholder="https://github.com/owner/repo または ~/Downloads/my-plugin"
                value={pluginSource}
                onChange={(e) => setPluginSource(e.target.value)}
                disabled={busy}
              />
              <button
                type="submit"
                className="settings-archive-btn primary"
                disabled={busy || !pluginSource.trim()}
              >
                {busy ? "導入中…" : "導入する"}
              </button>
            </div>
          </form>

          <div className="ext-list">
            {(data?.plugins ?? []).length === 0 ? (
              <div className="settings-archive-empty">
                導入されているプラグインはありません
              </div>
            ) : (
              (data?.plugins ?? []).map((p) => (
                <div key={p.id} className="ext-item">
                  <div className="ext-item-info">
                    <div className="ext-item-title-row">
                      <span className="ext-badge">
                        {p.version ? `v${p.version}` : "プラグイン"}
                      </span>
                      <span className="ext-item-title">{p.name}</span>
                    </div>
                    <div className="ext-item-desc">
                      {p.description || p.path}
                      {p.skillCount > 0 ? ` · スキル ${p.skillCount}件` : ""}
                      {p.hasMcp ? " · MCP同梱" : ""}
                    </div>
                  </div>
                  <div className="ext-item-actions">
                    <button
                      type="button"
                      className="settings-archive-btn danger"
                      disabled={busy}
                      onClick={() => void handleDeletePlugin(p.id)}
                    >
                      削除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="ext-tab-body">
          <p className="ext-hint">
            すべてのチャットで AI に常に守らせたいルール（<code>GEMINI.md</code>）を編集できます。（メモリタブの内容は自動で別枠に保持されます）
          </p>
          <textarea
            className="ext-textarea"
            rows={8}
            value={rulesDraft}
            onChange={(e) => {
              setRulesDraft(e.target.value);
              setRulesDirty(true);
            }}
            disabled={busy}
            placeholder="# 共通ルール&#10;- 返答は自然な日本語で行う&#10;- 重要な変更前は先に確認する"
          />
          <div className="ext-form-row" style={{ justifyContent: "flex-end" }}>
            <button
              type="button"
              className="settings-archive-btn primary"
              disabled={busy || !rulesDirty}
              onClick={() => void handleSaveRules()}
            >
              {busy ? "保存中…" : "共通ルールを保存"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
