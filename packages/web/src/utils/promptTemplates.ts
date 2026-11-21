/**
 * スラッシュコマンド＆プロンプトテンプレート集
 *
 * チャット入力欄で先頭に "/" を打つと呼び出せる定番テンプレートと、
 * ユーザーが自由に保存できる自作プロンプトを管理する。
 */

export interface PromptTemplateItem {
  id: string;
  command: string; // 例: "/要約"
  label: string;
  description: string;
  template: string;
  isBuiltin?: boolean;
}

const STORAGE_KEY = "porta:customPromptTemplates";

export const BUILTIN_PROMPT_TEMPLATES: ReadonlyArray<PromptTemplateItem> = [
  {
    id: "builtin-summary",
    command: "/要約",
    label: "要約する",
    description: "長い文章や議論の要点を箇条書きでまとめる",
    template: "以下の内容を、結論・重要なポイント3つ・次のアクションに分けて簡潔な日本語で要約してください：\n\n",
    isBuiltin: true,
  },
  {
    id: "builtin-translate",
    command: "/翻訳",
    label: "自然な日本語へ翻訳",
    description: "英語などの文章を自然な日本語へ翻訳する",
    template: "以下の文章を、意味を正確に保ちつつ自然な日本語に翻訳してください。専門用語があれば簡単に補足もお願いします：\n\n",
    isBuiltin: true,
  },
  {
    id: "builtin-review",
    command: "/レビュー",
    label: "コード・文章をレビュー",
    description: "バグや改善点を優先度順に指摘してもらう",
    template: "以下の内容をレビューし、「重大な問題」「改善提案」「良い点」に分けて具体的にフィードバックしてください：\n\n",
    isBuiltin: true,
  },
  {
    id: "builtin-polish",
    command: "/校正",
    label: "文章を丁寧に整える",
    description: "誤字脱字や言い回しをわかりやすくブラッシュアップ",
    template: "以下の文章の誤字脱字を直し、読みやすく丁寧な表現に整えてください（修正ポイントも一言添えてください）：\n\n",
    isBuiltin: true,
  },
  {
    id: "builtin-explain",
    command: "/わかりやすく",
    label: "初心者向けに噛み砕く",
    description: "専門的な内容を例え話を交えてやさしく解説",
    template: "以下の内容について、専門知識がない人にも直感的にわかるよう、身近な例えを交えてわかりやすく説明してください：\n\n",
    isBuiltin: true,
  },
  {
    id: "builtin-plan",
    command: "/手順",
    label: "実行ステップを作成",
    description: "目的からチェックリスト形式の手順を作る",
    template: "以下の目的を達成するための具体的なステップを、チェックリスト形式で順番に作成してください：\n\n",
    isBuiltin: true,
  },
];

export function loadCustomPromptTemplates(): PromptTemplateItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PromptTemplateItem =>
        item &&
        typeof item.id === "string" &&
        typeof item.command === "string" &&
        typeof item.template === "string",
    );
  } catch {
    return [];
  }
}

export function saveCustomPromptTemplates(items: PromptTemplateItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ストレージ制限時は無視
  }
}

export function getAllPromptTemplates(): PromptTemplateItem[] {
  return [...loadCustomPromptTemplates(), ...BUILTIN_PROMPT_TEMPLATES];
}

export function filterPromptTemplates(
  query: string,
  all: ReadonlyArray<PromptTemplateItem>,
): PromptTemplateItem[] {
  const q = query.trim().toLowerCase();
  if (!q || q === "/") return [...all];
  const bare = q.startsWith("/") ? q.slice(1) : q;
  return all.filter(
    (item) =>
      item.command.toLowerCase().includes(bare) ||
      item.label.toLowerCase().includes(bare) ||
      item.description.toLowerCase().includes(bare),
  );
}
