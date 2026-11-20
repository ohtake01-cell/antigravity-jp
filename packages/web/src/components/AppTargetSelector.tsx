import type { TargetApp } from "../types";

interface Props {
  value: TargetApp;
  onChange: (value: TargetApp) => void;
  className?: string;
}

export function AppTargetSelector({ value, onChange, className = "" }: Props) {
  return (
    <div className={`app-target-selector ${className}`}>
      <label htmlFor="app-target-select" className="sr-only">
        接続先エンジン
      </label>
      <select
        id="app-target-select"
        value={value}
        onChange={(e) => onChange(e.target.value as TargetApp)}
        className="app-target-dropdown select-input"
        title="接続先AIエンジンを切り替え (Antigravity 2 / Antigravity IDE)"
      >
        <option value="all">🌐 全エンジン</option>
        <option value="antigravity">🚀 Antigravity 2</option>
        <option value="antigravity-ide">⚡ Antigravity IDE</option>
      </select>
    </div>
  );
}
