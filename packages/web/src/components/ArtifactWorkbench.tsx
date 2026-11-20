import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { api } from "../api/client";
import type {
  WorkbenchFileKind,
  WorkbenchReadResponse,
  WorkbenchRecentFileItem,
} from "../types";

export interface ArtifactWorkbenchProps {
  isOpen: boolean;
  initialFileRef?: string | null;
  currentWorkspaceUri?: string | null;
  onClose: () => void;
}

type ViewMode = "preview" | "edit" | "split";

const KIND_LABELS: Record<WorkbenchFileKind, string> = {
  markdown: "📝 Markdown",
  csv: "📊 CSV / 表",
  mermaid: "🔀 Mermaid図",
  pdf: "📕 PDF",
  image: "🖼️ 画像",
  code: "💻 コード",
};

// ── RFC-4180-compatible CSV / TSV parser ──

export function parseDelimitedTable(
  raw: string,
  delimiter: "," | "\t",
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\r") {
      if (raw[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// ── Lightweight Offline Mermaid Flowchart / Sequence SVG Renderer ──

interface ParsedFlowNode {
  id: string;
  label: string;
}

interface ParsedFlowEdge {
  from: string;
  to: string;
  label?: string;
}

function parseMermaidFlowchart(src: string): {
  direction: "TD" | "LR";
  nodes: ParsedFlowNode[];
  edges: ParsedFlowEdge[];
} | null {
  const lines = src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("%%"));
  if (lines.length === 0) return null;

  const header = lines[0];
  const headerMatch = /^(?:flowchart|graph)\s+(TD|TB|LR|RL)?/i.exec(header);
  if (!headerMatch) return null;

  const dirRaw = (headerMatch[1] ?? "TD").toUpperCase();
  const direction: "TD" | "LR" =
    dirRaw === "LR" || dirRaw === "RL" ? "LR" : "TD";

  const nodeMap = new Map<string, string>();
  const edges: ParsedFlowEdge[] = [];

  const registerNode = (token: string): string => {
    const clean = token.trim();
    const m =
      /^([A-Za-z0-9_.-]+)\s*(?:\["([^"]+)"\]|\[([^\]]+)\]|\("([^"]+)"\)|\(([^)]+)\)|\{([^}]+)\})?$/.exec(
        clean,
      );
    if (!m) {
      const fallbackId = clean.replace(/[^A-Za-z0-9_.-]/g, "") || "node";
      if (!nodeMap.has(fallbackId)) nodeMap.set(fallbackId, clean);
      return fallbackId;
    }
    const id = m[1];
    const lbl = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
    if (lbl) {
      nodeMap.set(id, lbl.trim());
    } else if (!nodeMap.has(id)) {
      nodeMap.set(id, id);
    }
    return id;
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/;$/, "");
    if (/^(?:subgraph|end|style|classDef|class|click)\b/i.test(line)) {
      continue;
    }
    const arrowMatch =
      /^(.+?)\s*(?:-->|---|-\.->|==>)\s*(?:\|([^|]+)\|\s*)?(.+)$/.exec(line);
    if (arrowMatch) {
      const fromId = registerNode(arrowMatch[1]);
      const edgeLabel = arrowMatch[2]?.trim();
      const toId = registerNode(arrowMatch[3]);
      edges.push({ from: fromId, to: toId, label: edgeLabel });
    } else {
      registerNode(line);
    }
  }

  const nodes: ParsedFlowNode[] = [...nodeMap.entries()].map(([id, label]) => ({
    id,
    label,
  }));
  if (nodes.length === 0) return null;
  return { direction, nodes, edges };
}

function MermaidDiagramCard({ code }: { code: string }) {
  const parsed = useMemo(() => parseMermaidFlowchart(code), [code]);

  if (!parsed) {
    return (
      <div className="wb-mermaid-fallback" data-testid="mermaid-diagram">
        <div className="wb-mermaid-badge">🔀 Mermaid ダイアグラム</div>
        <pre className="wb-mermaid-raw">{code}</pre>
      </div>
    );
  }

  const { direction, nodes, edges } = parsed;
  const boxW = 168;
  const boxH = 44;
  const gapX = 64;
  const gapY = 52;
  const pad = 24;

  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((n, idx) => {
    if (direction === "LR") {
      const col = idx;
      positions.set(n.id, {
        x: pad + col * (boxW + gapX),
        y: pad + (idx % 2) * 28,
      });
    } else {
      positions.set(n.id, {
        x: pad + 40,
        y: pad + idx * (boxH + gapY),
      });
    }
  });

  const svgW =
    direction === "LR"
      ? Math.max(320, pad * 2 + nodes.length * (boxW + gapX) - gapX)
      : 320;
  const svgH =
    direction === "LR"
      ? 148
      : Math.max(120, pad * 2 + nodes.length * (boxH + gapY) - gapY);

  return (
    <div className="wb-mermaid-wrap" data-testid="mermaid-diagram">
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        role="img"
        aria-label="Mermaid フロー図"
      >
        <defs>
          <marker
            id="wb-arrow"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8 Z" fill="#818cf8" />
          </marker>
        </defs>
        {edges.map((edge, idx) => {
          const a = positions.get(edge.from);
          const b = positions.get(edge.to);
          if (!a || !b) return null;
          const x1 = direction === "LR" ? a.x + boxW : a.x + boxW / 2;
          const y1 = direction === "LR" ? a.y + boxH / 2 : a.y + boxH;
          const x2 = direction === "LR" ? b.x : b.x + boxW / 2;
          const y2 = direction === "LR" ? b.y + boxH / 2 : b.y;
          const mx = (x1 + x2) / 2;
          const my = (y1 + y2) / 2;
          return (
            <g key={`${edge.from}-${edge.to}-${idx}`}>
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#818cf8"
                strokeWidth="1.8"
                markerEnd="url(#wb-arrow)"
              />
              {edge.label && (
                <text
                  x={mx}
                  y={my - 6}
                  textAnchor="middle"
                  fill="#c7d2fe"
                  fontSize="11"
                >
                  {edge.label}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((node) => {
          const pos = positions.get(node.id)!;
          const label =
            node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label;
          return (
            <g key={node.id} transform={`translate(${pos.x}, ${pos.y})`}>
              <rect
                width={boxW}
                height={boxH}
                rx="9"
                fill="#1e2436"
                stroke="#4f5d87"
                strokeWidth="1.4"
              />
              <text
                x={boxW / 2}
                y={boxH / 2 + 4}
                textAnchor="middle"
                fill="#e8eaf0"
                fontSize="12"
                fontWeight="600"
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Split Markdown into text + ```mermaid blocks ──

function MarkdownWithMermaidPreview({ markdown }: { markdown: string }) {
  const parts = useMemo(() => {
    const out: Array<{ kind: "md" | "mermaid"; text: string }> = [];
    const regex = /```mermaid\s*\r?\n([\s\S]*?)```/gi;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(markdown)) !== null) {
      if (m.index > last) {
        out.push({ kind: "md", text: markdown.slice(last, m.index) });
      }
      out.push({ kind: "mermaid", text: m[1].trim() });
      last = m.index + m[0].length;
    }
    if (last < markdown.length) {
      out.push({ kind: "md", text: markdown.slice(last) });
    }
    return out;
  }, [markdown]);

  return (
    <div className="wb-markdown-body">
      {parts.map((p, idx) => {
        if (p.kind === "mermaid") {
          return <MermaidDiagramCard key={idx} code={p.text} />;
        }
        const html = marked.parse(p.text, {
          async: false,
          gfm: true,
          breaks: true,
        }) as string;
        return (
          <div key={idx} dangerouslySetInnerHTML={{ __html: html }} />
        );
      })}
    </div>
  );
}

// ── Interactive CSV / TSV Table ──

function CsvTableView({
  content,
  ext,
}: {
  content: string;
  ext: string;
}) {
  const delimiter: "," | "\t" = ext.toLowerCase() === ".tsv" ? "\t" : ",";
  const [filterText, setFilterText] = useState("");
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortAsc, setSortAsc] = useState(true);

  const parsedRows = useMemo(
    () => parseDelimitedTable(content, delimiter),
    [content, delimiter],
  );
  const headers = parsedRows[0] ?? [];
  const dataRows = useMemo(() => {
    let rows = parsedRows.slice(1);
    const q = filterText.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) => r.some((c) => c.toLowerCase().includes(q)));
    }
    if (sortCol !== null) {
      rows = [...rows].sort((a, b) => {
        const av = a[sortCol] ?? "";
        const bv = b[sortCol] ?? "";
        const an = Number(av);
        const bn = Number(bv);
        const cmp =
          !Number.isNaN(an) && !Number.isNaN(bn) && av !== "" && bv !== ""
            ? an - bn
            : av.localeCompare(bv, "ja");
        return sortAsc ? cmp : -cmp;
      });
    }
    return rows;
  }, [parsedRows, filterText, sortCol, sortAsc]);

  if (parsedRows.length === 0) {
    return <div className="wb-empty">空のテーブルファイルです</div>;
  }

  return (
    <div className="wb-csv-container">
      <div className="wb-csv-toolbar">
        <input
          type="text"
          className="wb-path-input"
          aria-label="表データを絞り込み"
          placeholder="キーワードで行を絞り込み…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        <span className="wb-meta-pill">
          {dataRows.length}行 × {headers.length}列
        </span>
      </div>
      <div className="wb-csv-scroll">
        <table className="wb-csv-table">
          <thead>
            <tr>
              {headers.map((h, colIdx) => (
                <th
                  key={colIdx}
                  onClick={() => {
                    if (sortCol === colIdx) {
                      setSortAsc((v) => !v);
                    } else {
                      setSortCol(colIdx);
                      setSortAsc(true);
                    }
                  }}
                >
                  <span>{h || `Col ${colIdx + 1}`}</span>
                  {sortCol === colIdx && (
                    <span className="wb-sort-ind">{sortAsc ? " ▲" : " ▼"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dataRows.slice(0, 500).map((row, rIdx) => (
              <tr key={rIdx}>
                {headers.map((_, cIdx) => (
                  <td key={cIdx}>{row[cIdx] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main ArtifactWorkbench Component ──

export function ArtifactWorkbench({
  isOpen,
  initialFileRef,
  currentWorkspaceUri,
  onClose,
}: ArtifactWorkbenchProps) {
  const [pathInput, setPathInput] = useState("");
  const [doc, setDoc] = useState<WorkbenchReadResponse | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [recentFiles, setRecentFiles] = useState<WorkbenchRecentFileItem[]>([]);
  const [imageZoomFit, setImageZoomFit] = useState(true);
  const [paneWidth, setPaneWidth] = useState(480);
  const highlightRowRef = useRef<HTMLDivElement | null>(null);

  const handleStartResize = useCallback(
    (startEv: React.MouseEvent<HTMLDivElement>) => {
      startEv.preventDefault();
      const startX = startEv.clientX;
      const startW = paneWidth;
      const onMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX;
        const next = Math.max(340, Math.min(820, startW + delta));
        setPaneWidth(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [paneWidth],
  );

  const isDirty = useMemo(() => {
    if (!doc || !doc.editable || doc.content === null) return false;
    return draftContent !== doc.content;
  }, [doc, draftContent]);

  const loadRecentFiles = useCallback(async () => {
    try {
      const res = await api.recentWorkbenchFiles(currentWorkspaceUri);
      setRecentFiles(res.files ?? []);
    } catch {
      // Optional helper list
    }
  }, [currentWorkspaceUri]);

  const openFile = useCallback(async (fileRef: string) => {
    const trimmed = fileRef.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setSaveNotice(null);
    try {
      const res = await api.readWorkbenchFile(trimmed);
      setDoc(res);
      setPathInput(res.path);
      setDraftContent(res.content ?? "");
      setViewMode("preview");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "ファイルの読み込みに失敗しました。",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void loadRecentFiles();
  }, [isOpen, loadRecentFiles]);

  useEffect(() => {
    if (isOpen && initialFileRef) {
      void openFile(initialFileRef);
    }
  }, [isOpen, initialFileRef, openFile]);

  useEffect(() => {
    if (doc?.startLine && highlightRowRef.current) {
      highlightRowRef.current.scrollIntoView?.({ block: "center" });
    }
  }, [doc?.path, doc?.startLine]);

  const handleSave = useCallback(async () => {
    if (!doc || !doc.editable) return;
    setSaving(true);
    setError(null);
    setSaveNotice(null);
    try {
      const res = await api.writeWorkbenchFile(doc.path, draftContent);
      setDoc((prev) =>
        prev
          ? {
              ...prev,
              content: draftContent,
              size: res.bytesWritten,
              mtime: res.mtime,
            }
          : prev,
      );
      setSaveNotice("✓ 保存しました");
      void loadRecentFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setSaving(false);
    }
  }, [doc, draftContent, loadRecentFiles]);

  const handleCreateScratchNote = useCallback(async () => {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T.Z]/g, "")
      .slice(0, 12);
    let baseDir = "~/Documents/AntigravityNotes";
    if (currentWorkspaceUri?.startsWith("file://")) {
      try {
        baseDir = `${decodeURIComponent(new URL(currentWorkspaceUri).pathname)}/notes`;
      } catch {
        // Keep default
      }
    }
    const newPath = `${baseDir}/memo_${stamp}.md`;
    const starter = `# メモ (${new Date().toLocaleString("ja-JP")})\n\n- ここに要点を記入できます\n`;
    setSaving(true);
    setError(null);
    try {
      await api.writeWorkbenchFile(newPath, starter);
      await openFile(newPath);
      setViewMode("split");
      void loadRecentFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "新規メモ作成に失敗しました。");
    } finally {
      setSaving(false);
    }
  }, [currentWorkspaceUri, loadRecentFiles, openFile]);

  if (!isOpen) return null;

  return (
    <aside
      className="wb-pane"
      style={{ width: `${paneWidth}px` }}
      aria-label="右ペイン独立エディタ＆多形式ビューア"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          if (doc?.editable) {
            e.preventDefault();
            void handleSave();
          }
        }
      }}
    >
      <div
        className="wb-resize-handle"
        role="separator"
        aria-orientation="vertical"
        title="ドラッグしてエディタ幅を調整"
        onMouseDown={handleStartResize}
      />
      {/* Top Header */}
      <div className="wb-header">
        <div className="wb-header-title-row">
          <span className="wb-kind-badge">
            {doc ? KIND_LABELS[doc.kind] : "📄 ワークベンチ"}
          </span>
          <span className="wb-doc-name" title={doc?.path ?? ""}>
            {doc ? doc.name : "ドキュメント＆成果物ビューア"}
          </span>
          {isDirty && <span className="wb-dirty-dot">● 未保存</span>}
          {saveNotice && <span className="wb-save-ok">{saveNotice}</span>}
        </div>
        <div className="wb-header-actions">
          {doc?.editable && (
            <div className="wb-mode-tabs" role="tablist" aria-label="エディタ表示切替">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "preview"}
                className={`wb-mode-btn ${viewMode === "preview" ? "active" : ""}`}
                onClick={() => setViewMode("preview")}
              >
                👁️ 表示
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "edit"}
                className={`wb-mode-btn ${viewMode === "edit" ? "active" : ""}`}
                onClick={() => setViewMode("edit")}
              >
                ✏️ 編集
              </button>
              {(doc.kind === "markdown" || doc.kind === "mermaid") && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === "split"}
                  className={`wb-mode-btn ${viewMode === "split" ? "active" : ""}`}
                  onClick={() => setViewMode("split")}
                >
                  ◫ 分割
                </button>
              )}
            </div>
          )}
          {doc?.editable && (
            <button
              type="button"
              className="wb-save-btn"
              disabled={saving || !isDirty}
              onClick={() => void handleSave()}
              title="保存 (⌘S)"
            >
              {saving ? "保存中…" : "💾 保存"}
            </button>
          )}
          <button
            type="button"
            className="wb-close-btn"
            aria-label="ワークベンチを閉じる"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      {/* File Open Bar + Recent Files */}
      <div className="wb-open-bar">
        <div className="wb-open-row">
          <input
            type="text"
            className="wb-path-input"
            aria-label="開くファイルパス"
            placeholder="~/... (.md / .csv / .pdf / .mmd / .ts)"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void openFile(pathInput);
              }
            }}
          />
          <button
            type="button"
            className="wb-open-btn"
            disabled={loading || !pathInput.trim()}
            onClick={() => void openFile(pathInput)}
          >
            開く
          </button>
          <button
            type="button"
            className="wb-open-btn secondary"
            disabled={saving}
            onClick={() => void handleCreateScratchNote()}
            title="新しいMarkdownメモを作成して開く"
          >
            ＋ 新規メモ
          </button>
        </div>
        {recentFiles.length > 0 && (
          <div className="wb-recent-strip" aria-label="最近のファイル候補">
            {recentFiles.slice(0, 8).map((item) => (
              <button
                key={item.path}
                type="button"
                className={`wb-recent-chip ${doc?.path === item.path ? "active" : ""}`}
                title={item.path}
                onClick={() => void openFile(item.path)}
              >
                {item.source === "artifact" ? "🧠 " : "📄 "}
                {item.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Error Banner */}
      {error && (
        <div className="wb-error" role="alert">
          ⚠️ {error}
        </div>
      )}

      {/* Main Content Area */}
      <div className={`wb-body ${viewMode === "split" ? "is-split" : ""}`}>
        {loading ? (
          <div className="wb-empty">読み込み中…</div>
        ) : !doc ? (
          <div className="wb-empty">
            チャット内のファイルリンクをクリックするか、上の候補・パス入力から
            Markdown / CSV / PDF / Mermaid / コードを開けます。
          </div>
        ) : doc.kind === "pdf" && doc.rawUrl ? (
          <iframe
            className="wb-pdf-frame"
            title={`PDFプレビュー: ${doc.name}`}
            src={doc.rawUrl}
          />
        ) : doc.kind === "image" && doc.rawUrl ? (
          <div className="wb-image-view">
            <div className="wb-image-toolbar">
              <button
                type="button"
                className="wb-open-btn secondary"
                onClick={() => setImageZoomFit((v) => !v)}
              >
                {imageZoomFit ? "🔍 原寸表示" : "📐 枠内に収める"}
              </button>
            </div>
            <img
              src={doc.rawUrl}
              alt={doc.name}
              className={imageZoomFit ? "fit" : "actual"}
            />
          </div>
        ) : viewMode === "edit" ? (
          <textarea
            className="wb-editor-textarea"
            aria-label="ファイル直接編集エディタ"
            value={draftContent}
            onChange={(e) => setDraftContent(e.target.value)}
            spellCheck={false}
          />
        ) : viewMode === "split" ? (
          <div className="wb-split-grid">
            <textarea
              className="wb-editor-textarea"
              aria-label="ファイル直接編集エディタ"
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              spellCheck={false}
            />
            <div className="wb-split-preview">
              {doc.kind === "mermaid" ? (
                <MermaidDiagramCard code={draftContent} />
              ) : (
                <MarkdownWithMermaidPreview markdown={draftContent} />
              )}
            </div>
          </div>
        ) : doc.kind === "markdown" ? (
          <div className="wb-preview-scroll">
            <MarkdownWithMermaidPreview markdown={draftContent} />
          </div>
        ) : doc.kind === "mermaid" ? (
          <div className="wb-preview-scroll">
            <MermaidDiagramCard code={draftContent} />
          </div>
        ) : doc.kind === "csv" ? (
          <CsvTableView content={draftContent} ext={doc.ext} />
        ) : (
          <div className="wb-code-scroll">
            {draftContent.split(/\r?\n/).map((line, idx) => {
              const lineNo = idx + 1;
              const highlighted =
                doc.startLine !== null &&
                doc.startLine !== undefined &&
                lineNo >= doc.startLine &&
                lineNo <= (doc.endLine ?? doc.startLine);
              return (
                <div
                  key={lineNo}
                  ref={lineNo === doc.startLine ? highlightRowRef : undefined}
                  className={`wb-code-line ${highlighted ? "highlighted" : ""}`}
                >
                  <span className="wb-line-no">{lineNo}</span>
                  <span className="wb-line-text">{line || " "}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
