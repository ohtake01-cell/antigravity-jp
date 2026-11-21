import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

export interface LocalFeedbackEntry {
  id: string;
  kind: "bug" | "improvement";
  severity: "high" | "medium" | "low";
  status: "open" | "in_progress" | "resolved";
  source: "ai" | "user";
  reporterName: string;
  title: string;
  detail: string;
  appVersion: string;
  resolutionNote?: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
}

const DEFAULT_ISSUES_URL =
  "https://github.com/ohtake01-cell/antigravity-jp/issues/new";

export function FeedbackSection() {
  const [items, setItems] = useState<LocalFeedbackEntry[]>([]);
  const [appVersion, setAppVersion] = useState("1.5.4");
  const [platform, setPlatform] = useState("darwin");
  const [arch, setArch] = useState("arm64");
  const [issuesUrl, setIssuesUrl] = useState(DEFAULT_ISSUES_URL);

  const [kind, setKind] = useState<"bug" | "improvement">("bug");
  const [severity, setSeverity] = useState<"high" | "medium" | "low">("medium");
  const [source, setSource] = useState<"user" | "ai">("user");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (typeof api.feedbackList !== "function") return;
    try {
      const res = await api.feedbackList();
      if (res?.ok) {
        setItems(Array.isArray(res.items) ? res.items : []);
        if (res.appVersion) setAppVersion(res.appVersion);
        if (res.platform) setPlatform(res.platform);
        if (res.arch) setArch(res.arch);
        if (res.issuesUrl) setIssuesUrl(res.issuesUrl);
      }
    } catch {
      // ignore offline/test
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flashNotice = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 2600);
  };

  const buildReportMarkdown = () => {
    const kindLabel = kind === "bug" ? "バグ報告" : "改善提案";
    const sevLabel =
      severity === "high" ? "高" : severity === "low" ? "低" : "中";
    return [
      `### 種別: ${kindLabel}（重要度: ${sevLabel} / 報告元: ${source === "ai" ? "AI" : "ユーザー"}）`,
      `- アプリバージョン: Antigravity 日本語版 v${appVersion}`,
      `- 動作環境: ${platform} (${arch})`,
      "",
      "### 内容・再現手順",
      detail.trim() || "（ここに状況や希望する改善内容をご記入ください）",
    ].join("\n");
  };

  const handleSaveLocal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || saving || typeof api.createFeedback !== "function") return;
    setSaving(true);
    try {
      const res = await api.createFeedback({
        kind,
        severity,
        source,
        title: title.trim(),
        detail: detail.trim(),
      });
      if (res?.ok && res.item) {
        setItems((prev) => [res.item as LocalFeedbackEntry, ...prev]);
        setTitle("");
        setDetail("");
        flashNotice("アプリ内ボードへ保存しました");
      }
    } catch {
      flashNotice("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const handleOpenGitHubIssue = () => {
    const prefix = kind === "bug" ? "[バグ] " : "[改善] ";
    const issueTitle = `${prefix}${title.trim() || "フィードバック"}`;
    const body = buildReportMarkdown();
    const label = kind === "bug" ? "bug" : "enhancement";
    const url = `${issuesUrl}?title=${encodeURIComponent(issueTitle)}&body=${encodeURIComponent(body)}&labels=${encodeURIComponent(label)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleCopyTemplate = () => {
    const md = `## ${kind === "bug" ? "[バグ]" : "[改善]"} ${title.trim() || "フィードバック"}\n\n${buildReportMarkdown()}`;
    navigator.clipboard
      ?.writeText(md)
      .then(() => flashNotice("報告テンプレートをコピーしました"))
      .catch(() => {});
  };

  const handleToggleStatus = async (item: LocalFeedbackEntry) => {
    if (typeof api.updateFeedback !== "function") return;
    const nextStatus = item.status === "resolved" ? "open" : "resolved";
    try {
      const res = await api.updateFeedback(item.id, { status: nextStatus });
      if (res?.ok && res.item) {
        setItems((prev) =>
          prev.map((x) => (x.id === item.id ? (res.item as LocalFeedbackEntry) : x)),
        );
      }
    } catch {
      // ignore
    }
  };

  const handleDelete = async (id: string) => {
    if (typeof api.deleteFeedback !== "function") return;
    try {
      await api.deleteFeedback(id);
      setItems((prev) => prev.filter((x) => x.id !== id));
    } catch {
      // ignore
    }
  };

  const openCount = items.filter((i) => i.status !== "resolved").length;

  return (
    <div className="settings-section" data-testid="feedback-section">
      <div className="feedback-section-head">
        <h2 className="settings-section-title">
          🐛 バグ報告・改善提案（未対応 {openCount}件）
        </h2>
        {notice && <span className="feedback-notice-pill">{notice}</span>}
      </div>
      <p className="settings-row-desc" style={{ marginBottom: 10 }}>
        気づいた不具合や改善アイデアをアプリ内に記録したり、開発者（GitHub Issues）へ個人情報なしで直接送信できます。AI チャットからも{" "}
        <code>POST /api/feedback</code> で自動登録できます。
      </p>

      <form className="feedback-form-box" onSubmit={(e) => void handleSaveLocal(e)}>
        <div className="feedback-form-controls">
          <div className="feedback-kind-group">
            <button
              type="button"
              className={`ext-tab-btn ${kind === "bug" ? "active" : ""}`}
              onClick={() => setKind("bug")}
            >
              🐛 バグ報告
            </button>
            <button
              type="button"
              className={`ext-tab-btn ${kind === "improvement" ? "active" : ""}`}
              onClick={() => setKind("improvement")}
            >
              💡 改善提案
            </button>
          </div>
          <select
            className="ext-select"
            aria-label="重要度"
            value={severity}
            onChange={(e) =>
              setSeverity(e.target.value as "high" | "medium" | "low")
            }
          >
            <option value="high">重要度: 高</option>
            <option value="medium">重要度: 中</option>
            <option value="low">重要度: 低</option>
          </select>
          <select
            className="ext-select"
            aria-label="報告元"
            value={source}
            onChange={(e) => setSource(e.target.value as "user" | "ai")}
          >
            <option value="user">👤 ユーザー</option>
            <option value="ai">🤖 AI報告</option>
          </select>
        </div>

        <input
          type="text"
          className="ext-input"
          aria-label="バグ・改善タイトル"
          placeholder="例：ライトモードで見えにくい箇所がある / ○○機能がほしい"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="ext-textarea"
          rows={3}
          aria-label="詳細・再現手順"
          placeholder="発生した操作手順や、こうなると嬉しいというアイデア（任意）"
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
        />

        <div className="feedback-form-actions">
          <button
            type="submit"
            className="settings-archive-btn primary"
            disabled={saving || !title.trim()}
          >
            {saving ? "保存中…" : "📝 アプリ内に保存"}
          </button>
          <button
            type="button"
            className="settings-archive-btn"
            onClick={handleOpenGitHubIssue}
            title="バージョンとOS情報のみ自動入力してGitHub Issuesフォームを開きます（個人情報なし）"
          >
            🐙 GitHub で開発者へ送信
          </button>
          <button
            type="button"
            className="settings-archive-btn"
            onClick={handleCopyTemplate}
          >
            📋 報告文をコピー
          </button>
        </div>
      </form>

      {items.length > 0 && (
        <div className="feedback-saved-list">
          {items.map((item) => (
            <div
              key={item.id}
              className={`feedback-saved-card ${item.status === "resolved" ? "resolved" : ""}`}
              data-testid="local-feedback-card"
            >
              <div className="feedback-saved-top">
                <div className="feedback-saved-badges">
                  <span className={`feedback-pill kind-${item.kind}`}>
                    {item.kind === "bug" ? "🐛 バグ" : "💡 改善"}
                  </span>
                  <span className="feedback-pill">
                    {item.source === "ai" ? "🤖 AI報告" : "👤 ユーザー"}
                  </span>
                  <span className={`feedback-pill st-${item.status}`}>
                    {item.status === "resolved" ? "解決済み" : "未対応"}
                  </span>
                </div>
                <div className="feedback-saved-btns">
                  <button
                    type="button"
                    className="settings-archive-btn"
                    onClick={() => void handleToggleStatus(item)}
                  >
                    {item.status === "resolved" ? "🔄 再開" : "✅ 解決済み"}
                  </button>
                  <button
                    type="button"
                    className="settings-archive-btn danger"
                    onClick={() => void handleDelete(item.id)}
                  >
                    削除
                  </button>
                </div>
              </div>
              <div className="feedback-saved-title">{item.title}</div>
              {item.detail && (
                <div className="feedback-saved-detail">{item.detail}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
