import { useEffect, useRef, useState } from "react";
import {
  IconCheck,
  IconEye,
  IconLock,
  IconShield,
  IconShieldAlert,
} from "./Icons";
import type { LocalPermissionMode } from "../types";

export interface LocalPermissionOption {
  value: LocalPermissionMode;
  label: string;
  shortLabel: string;
  description: string;
}

export const LOCAL_PERMISSION_OPTIONS: LocalPermissionOption[] = [
  {
    value: "request_review",
    label: "毎回確認",
    shortLabel: "毎回確認",
    description: "すべてのコマンド実行前に承認を求めます。",
  },
  {
    value: "default",
    label: "標準",
    shortLabel: "標準",
    description: "重要な操作の前に確認を求めます。",
  },
  {
    value: "auto",
    label: "自動判定",
    shortLabel: "自動判定",
    description: "コマンドを実行するかを自動で判断します。",
  },
  {
    value: "turbo",
    label: "ターボ（制限なし）",
    shortLabel: "ターボ",
    description: "すべてのコマンドを制限なしで自動実行します。",
  },
];

function PermissionIcon({
  mode,
  size = 14,
}: {
  mode: LocalPermissionMode;
  size?: number;
}) {
  switch (mode) {
    case "request_review":
      return <IconEye size={size} />;
    case "default":
      return <IconLock size={size} />;
    case "auto":
      return <IconShield size={size} />;
    case "turbo":
      return <IconShieldAlert size={size} />;
  }
}

interface Props {
  value: LocalPermissionMode;
  defaultValue?: LocalPermissionMode;
  onSelect: (mode: LocalPermissionMode) => void;
  disabled?: boolean;
}

export function LocalPermissionSelector({
  value,
  defaultValue = "default",
  onSelect,
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const active =
    LOCAL_PERMISSION_OPTIONS.find((opt) => opt.value === value) ??
    LOCAL_PERMISSION_OPTIONS[1];

  return (
    <div className="model-selector local-permission-selector" ref={ref}>
      <button
        type="button"
        className={`model-selector-btn local-permission-btn${value === "turbo" ? " is-turbo" : ""}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title={`ローカル実行権限: ${active.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="local-permission-btn-icon">
          <PermissionIcon mode={active.value} size={13} />
        </span>
        <span className="model-selector-label">{active.shortLabel}</span>
        <span className="model-selector-caret">▾</span>
      </button>

      {open && (
        <div
          className="model-selector-dropdown local-permission-dropdown"
          role="listbox"
          aria-label="ローカル実行権限"
        >
          <div className="local-permission-heading">ローカル実行権限</div>
          {LOCAL_PERMISSION_OPTIONS.map((opt) => {
            const isSelected = opt.value === value;
            const isDefault = opt.value === defaultValue;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`local-permission-option${isSelected ? " active" : ""}${opt.value === "turbo" ? " turbo-opt" : ""}`}
                onClick={() => {
                  onSelect(opt.value);
                  setOpen(false);
                }}
              >
                <span className="local-permission-opt-icon">
                  <PermissionIcon mode={opt.value} size={15} />
                </span>
                <span className="local-permission-opt-body">
                  <span className="local-permission-opt-title-row">
                    <span className="local-permission-opt-label">
                      {opt.label}
                    </span>
                    {isDefault && (
                      <span className="local-permission-default-badge">
                        既定
                      </span>
                    )}
                  </span>
                  <span className="local-permission-opt-desc">
                    {opt.description}
                  </span>
                </span>
                <span className="local-permission-opt-check" aria-hidden="true">
                  {isSelected ? <IconCheck size={14} /> : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
